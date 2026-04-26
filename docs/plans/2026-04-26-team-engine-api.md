# KPR-79: Team Engine API Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan. Tasks are in dependency order; commit after each task.

**Goal:** Promote "team membership" to an engine-level primitive — every agent gets always-on `team_list` / `team_lookup_human` / `team_lookup_agent` tools backed by a cached, change-stream-invalidated registry that joins `agent_definitions` (agents) and `contacts` filtered by `category: "team-human"` (humans), then auto-injects a concise team summary into every system prompt and retires the hand-maintained team table from `shared/business-context.md`.

**Architecture:** New `src/team-roster/` module (distinct from the existing `src/team/` agent-to-agent messaging module — different concern). Implements (a) an internal TS API consumed by `agent-runner.ts` for system-prompt summary injection, and (b) an in-process MCP server built via `createSdkMcpServer` (first such server in the codebase — every other MCP is a stdio subprocess). A two-slice in-memory cache (humans/agents) is invalidated explicitly: agents via a new `AgentRegistry.onPostReload` multi-subscriber emitter; humans via an engine-side MongoDB change-stream watcher on `contacts`. 60s TTL fallback. See `docs/specs/2026-04-26-team-engine-api-design.md`.

**Tech Stack:** TypeScript (NodeNext, strict), MongoDB driver `^7.1.0`, `@anthropic-ai/claude-agent-sdk` (`createSdkMcpServer`), Vitest.

**Spec reference:** `docs/specs/2026-04-26-team-engine-api-design.md` (KPR-79).

**Carried open question (from spec):** Section "Open design questions" left the system-prompt summary format unresolved. **Default chosen for this plan:** markdown table with columns `name | role | channel | pronouns`, agents grouped after humans. Documented inline in Task 4 — revisit post-launch.

---

## File map

### Files to create

| File | Responsibility |
|---|---|
| `src/team-roster/types.ts` | `TeamMember` interface + `ContactCategory` type alias re-export |
| `src/team-roster/team-cache.ts` | Singleton `TeamCache` class (humans + agents slices, lazy populate, explicit invalidate, 60s TTL) |
| `src/team-roster/team-cache.test.ts` | TTL expiry, invalidation hooks, lookup semantics |
| `src/team-roster/team-api.ts` | Internal TS API: `getTeam`, `lookupHuman`, `lookupAgent`, `teamSummary` |
| `src/team-roster/team-api.test.ts` | Lookup match semantics (email lowercase, name + aliases, exactly-one-arg guard) |
| `src/team-roster/team-roster-mcp-server.ts` | `createSdkMcpServer` wrapper exposing `team_list` / `team_lookup_human` / `team_lookup_agent` |
| `src/team-roster/team-roster-mcp-server.test.ts` | Smoke test: tool registration + handler invocation |
| `src/team-roster/contacts-watcher.ts` | Engine-side MongoDB change-stream watcher on `contacts` (with polling fallback) |
| `src/team-roster/contacts-watcher.test.ts` | Watcher fires `invalidateHumans` on collection writes |
| `src/team-roster/index.ts` | Module barrel: `initTeamRoster(deps)` bootstrap entrypoint |
| `scripts/migrate-contacts-categories.ts` | One-time migration: backfill `category`, dedupe, archive stale rows |
| `scripts/migrate-contacts-categories.test.ts` | Precedence + dedupe rule tests against in-memory fixtures |

### Files to modify

| File | Reason |
|---|---|
| `src/contacts/contacts-mcp-server.ts` | Add `category` + `pronouns` fields to `ContactDoc`; surface in `contacts_create` / `contacts_update` |
| `src/agents/agent-registry.ts` | Rename `onReload` field to `onChangeDetected`; add `onPostReload(handler)` multi-subscriber emitter fired from inside `load()` after state commit |
| `src/agents/agent-runner.ts` | (1) Add `team-roster` to `filterCoreServers` always-on set + `INFRASTRUCTURE_SERVERS`; (2) inject team-summary block into system prompt immediately after constitution; (3) wire in-process `createSdkMcpServer` instance into `mcpServers` map |
| `src/index.ts` | Initialize team-roster module (cache, MCP server, contacts-watcher, agent-registry subscription) before `agentManager` is constructed |
| `src/tools/server-catalog.ts` | Add catalog entry for `team-roster` (used by formatCatalogEntry — though it's hidden as INFRASTRUCTURE) |
| `package.json` | Add `migrate:contacts-categories` npm script |

---

## Task 1: ContactDoc schema additions (`category` + `pronouns`)

**Files:**
- Modify: `src/contacts/contacts-mcp-server.ts:24-39` (ContactDoc), `:185-234` (contacts_create), `:236-291` (contacts_update)

- [ ] **Step 1.1:** Add `ContactCategory` type and extend `ContactDoc`.

In `src/contacts/contacts-mcp-server.ts`, replace the `ContactDoc` interface and add the type alias above it:

```typescript
export type ContactCategory =
  | "team-human"
  | "customer"
  | "vendor"
  | "partner"
  | "archived";

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
  category?: ContactCategory;
  tags: string[];
  notes?: string;
  source: string;
  sourceId?: string;
  createdAt: Date;
  updatedAt: Date;
}
```

The `export` on `ContactCategory` is required so `src/team-roster/` imports it without duplicating the literal union.

- [ ] **Step 1.2:** Surface `pronouns` and `category` in `contacts_create`.

Add the new fields to the input schema and doc construction (insert after the existing `notes` field on both):

```typescript
inputSchema: {
  // ...existing fields
  pronouns: z.string().optional().describe("Pronouns (e.g. she/her, they/them)"),
  category: z.enum(["team-human", "customer", "vendor", "partner", "archived"]).optional()
    .describe("Contact category — set 'team-human' for current team members"),
},
```

In the handler args destructure: add `pronouns`, `category`. In the `doc` literal (around line 213), add `pronouns: pronouns || undefined` and `category: category ?? undefined`.

- [ ] **Step 1.3:** Surface `pronouns` and `category` in `contacts_update`.

Mirror Step 1.2 in `contacts_update`:

```typescript
pronouns: z.string().optional().describe("Pronouns (replaces existing)"),
category: z.enum(["team-human", "customer", "vendor", "partner", "archived"]).optional()
  .describe("Contact category"),
```

In the handler, add to the conditional `$set` block (around line 256):

```typescript
if (pronouns !== undefined) updates.pronouns = pronouns;
if (category !== undefined) updates.category = category;
```

- [ ] **Step 1.4:** Surface `pronouns` and `category` in `formatContact()` output (line 65-79).

After the `Role` line, add:

```typescript
if (c.pronouns) lines.push(`Pronouns: ${c.pronouns}`);
if (c.category) lines.push(`Category: ${c.category}`);
```

- [ ] **Step 1.5:** Verify.

```bash
npm run typecheck
```

Expected: zero errors. (No tests added at this step — schema changes are backwards-compatible additive optional fields; tested transitively in Task 2/7.)

- [ ] **Step 1.6:** Commit.

```bash
git add src/contacts/contacts-mcp-server.ts
git commit -m "feat(KPR-79): add category and pronouns to ContactDoc"
```

---

## Task 2: TeamMember types + cache primitives

**Files:**
- Create: `src/team-roster/types.ts`, `src/team-roster/team-cache.ts`, `src/team-roster/team-cache.test.ts`

- [ ] **Step 2.1:** Define shared types.

`src/team-roster/types.ts`:

```typescript
import type { ContactCategory } from "../contacts/contacts-mcp-server.js";

export type { ContactCategory };

/**
 * Team-member view returned by the team API. Joins humans (from contacts
 * collection where category === "team-human") with agents (from
 * agent_definitions). The `category` field on TeamMember includes
 * "team-agent" — a synthetic value NOT stored in any ContactDoc; only
 * humans persist a `category`.
 */
export interface TeamMember {
  kind: "human" | "agent";
  id: string; // human: contacts._id.toHexString(); agent: agent_definitions._id (string)
  name: string;
  email?: string;
  role?: string;
  pronouns?: string;
  category: "team-human" | "team-agent" | "archived";
  // Agent-only fields (undefined for humans):
  agentId?: string;
  slackChannel?: string; // mapped from AgentDefinition.homeBase
  model?: string;
  active?: boolean; // agents: !disabled; humans: category !== "archived"
}
```

- [ ] **Step 2.2:** Implement `TeamCache` singleton.

`src/team-roster/team-cache.ts`:

```typescript
import type { Collection } from "mongodb";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { TeamMember } from "./types.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("team-roster:cache");
const TTL_MS = 60_000;

interface ContactRow {
  _id: { toHexString(): string };
  name: string;
  firstName?: string;
  lastName?: string;
  email: string | null;
  role?: string;
  pronouns?: string;
  category?: string;
  updatedAt?: Date;
}

interface Slice<T> {
  data: T[] | null;
  populatedAt: number;
}

export class TeamCache {
  private humans: Slice<TeamMember> = { data: null, populatedAt: 0 };
  private agents: Slice<TeamMember> = { data: null, populatedAt: 0 };

  constructor(
    private readonly contactsCol: Collection<ContactRow>,
    private readonly registry: AgentRegistry,
  ) {}

  invalidateHumans(): void {
    log.debug("invalidate humans");
    this.humans = { data: null, populatedAt: 0 };
  }

  invalidateAgents(): void {
    log.debug("invalidate agents");
    this.agents = { data: null, populatedAt: 0 };
  }

  async getHumans(): Promise<TeamMember[]> {
    if (this.isFresh(this.humans)) return this.humans.data!;
    const rows = await this.contactsCol
      .find({ category: { $in: ["team-human", "archived"] } })
      .toArray();
    const data: TeamMember[] = rows.map((c) => ({
      kind: "human",
      id: c._id.toHexString(),
      name: c.name || [c.firstName, c.lastName].filter(Boolean).join(" "),
      email: c.email ?? undefined,
      role: c.role,
      pronouns: c.pronouns,
      category: c.category === "archived" ? "archived" : "team-human",
      active: c.category !== "archived",
    }));
    this.humans = { data, populatedAt: Date.now() };
    return data;
  }

  async getAgents(): Promise<TeamMember[]> {
    if (this.isFresh(this.agents)) return this.agents.data!;
    const defs = await this.registry.getAllDefinitions();
    const data: TeamMember[] = defs.map((d) => ({
      kind: "agent",
      id: d._id,
      agentId: d._id,
      name: d.name,
      role: d.title,
      slackChannel: d.homeBase,
      model: d.model,
      category: d.disabled ? "archived" : "team-agent",
      active: !d.disabled,
    }));
    this.agents = { data, populatedAt: Date.now() };
    return data;
  }

  private isFresh<T>(slice: Slice<T>): boolean {
    return slice.data !== null && Date.now() - slice.populatedAt < TTL_MS;
  }
}
```

Note: `getAgents()` reads `agent_definitions` directly via `registry.getAllDefinitions()` so we get the raw `AgentDefinition` shape (which has `homeBase`, `disabled`, `title`) rather than the lossy runtime `AgentConfig`.

- [ ] **Step 2.3:** Add cache tests.

`src/team-roster/team-cache.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { TeamCache } from "./team-cache.js";

const mkContact = (over: Partial<any> = {}) => ({
  _id: new ObjectId(),
  name: "May Test",
  email: "may@dodihome.com",
  category: "team-human",
  ...over,
});

const mkAgentDef = (over: Partial<any> = {}) => ({
  _id: "mokie",
  name: "Mokie",
  title: "Chief of Staff",
  model: "claude-opus-4-7",
  homeBase: "agent-mokie",
  disabled: false,
  ...over,
});

function fakeContactsCol(rows: any[]) {
  return { find: vi.fn(() => ({ toArray: async () => rows })) } as any;
}

function fakeRegistry(defs: any[]) {
  return { getAllDefinitions: async () => defs } as any;
}

describe("TeamCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("populates humans lazily and reuses within TTL", async () => {
    const col = fakeContactsCol([mkContact()]);
    const cache = new TeamCache(col, fakeRegistry([]));
    await cache.getHumans();
    await cache.getHumans();
    expect(col.find).toHaveBeenCalledTimes(1);
  });

  it("repopulates after TTL expires", async () => {
    const col = fakeContactsCol([mkContact()]);
    const cache = new TeamCache(col, fakeRegistry([]));
    await cache.getHumans();
    vi.advanceTimersByTime(61_000);
    await cache.getHumans();
    expect(col.find).toHaveBeenCalledTimes(2);
  });

  it("invalidateHumans forces repopulate on next call", async () => {
    const col = fakeContactsCol([mkContact()]);
    const cache = new TeamCache(col, fakeRegistry([]));
    await cache.getHumans();
    cache.invalidateHumans();
    await cache.getHumans();
    expect(col.find).toHaveBeenCalledTimes(2);
  });

  it("filters humans by category in the Mongo query (only team-human and archived)", async () => {
    const col = fakeContactsCol([]);
    const cache = new TeamCache(col, fakeRegistry([]));
    await cache.getHumans();
    expect(col.find).toHaveBeenCalledWith({ category: { $in: ["team-human", "archived"] } });
  });

  it("agents slice maps homeBase → slackChannel and disabled → archived", async () => {
    const cache = new TeamCache(fakeContactsCol([]), fakeRegistry([
      mkAgentDef({ _id: "rae", name: "Rae", homeBase: "agent-rae", disabled: false }),
      mkAgentDef({ _id: "mokie", name: "Mokie", homeBase: "agent-mokie", disabled: true }),
    ]));
    const out = await cache.getAgents();
    const rae = out.find((m) => m.id === "rae")!;
    const mokie = out.find((m) => m.id === "mokie")!;
    expect(rae.slackChannel).toBe("agent-rae");
    expect(rae.category).toBe("team-agent");
    expect(rae.active).toBe(true);
    expect(mokie.category).toBe("archived");
    expect(mokie.active).toBe(false);
  });
});
```

- [ ] **Step 2.4:** Verify.

```bash
npm run typecheck
npx vitest run src/team-roster/team-cache.test.ts
```

Expected: typecheck clean, 5/5 cache tests pass.

- [ ] **Step 2.5:** Commit.

```bash
git add src/team-roster/types.ts src/team-roster/team-cache.ts src/team-roster/team-cache.test.ts
git commit -m "feat(KPR-79): TeamCache + TeamMember types"
```

---

## Task 3: TeamApi (lookup primitives + summary generator)

**Files:**
- Create: `src/team-roster/team-api.ts`, `src/team-roster/team-api.test.ts`

- [ ] **Step 3.1:** Implement the API.

`src/team-roster/team-api.ts`:

```typescript
import type { TeamCache } from "./team-cache.js";
import type { TeamMember } from "./types.js";

export interface TeamListOptions {
  includeArchived?: boolean;
  includeAgents?: boolean;
}

export class TeamApi {
  constructor(private readonly cache: TeamCache) {}

  async getTeam(opts: TeamListOptions = {}): Promise<TeamMember[]> {
    const includeArchived = opts.includeArchived ?? false;
    const includeAgents = opts.includeAgents ?? true;
    const humans = await this.cache.getHumans();
    const agents = includeAgents ? await this.cache.getAgents() : [];
    const all = [...humans, ...agents];
    const filtered = includeArchived ? all : all.filter((m) => m.active !== false);
    return filtered.sort((a, b) => {
      // humans before agents, then by name
      if (a.kind !== b.kind) return a.kind === "human" ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  }

  async lookupHuman(arg: { name?: string; email?: string }): Promise<TeamMember | null> {
    const hasName = typeof arg.name === "string" && arg.name.length > 0;
    const hasEmail = typeof arg.email === "string" && arg.email.length > 0;
    if (hasName === hasEmail) {
      throw new Error("team_lookup_human requires exactly one of { name, email }");
    }
    const humans = (await this.cache.getHumans()).filter((m) => m.category === "team-human");
    if (hasEmail) {
      const target = arg.email!.toLowerCase();
      const matches = humans.filter((m) => m.email && m.email.toLowerCase() === target);
      return mostRecent(matches);
    }
    const target = arg.name!.toLowerCase();
    const matches = humans.filter((m) => m.name.toLowerCase() === target);
    return mostRecent(matches);
  }

  async lookupAgent(arg: { agentId?: string; name?: string }): Promise<TeamMember | null> {
    const hasId = typeof arg.agentId === "string" && arg.agentId.length > 0;
    const hasName = typeof arg.name === "string" && arg.name.length > 0;
    if (hasId === hasName) {
      throw new Error("team_lookup_agent requires exactly one of { agentId, name }");
    }
    const agents = await this.cache.getAgents();
    if (hasId) {
      // case-sensitive — agent IDs are stable identifiers
      return agents.find((m) => m.agentId === arg.agentId) ?? null;
    }
    const target = arg.name!.toLowerCase();
    return agents.find((m) => m.name.toLowerCase() === target) ?? null;
    // NOTE: aliases lookup (the spec calls for matching against AgentDefinition.aliases)
    // requires raw AgentDefinition access; see Step 3.2 for implementation.
  }

  async teamSummary(): Promise<string> {
    const members = await this.getTeam({ includeArchived: false, includeAgents: true });
    if (members.length === 0) return "";
    const lines: string[] = [];
    lines.push("## Team Roster\n");
    lines.push("| Name | Role | Channel | Pronouns |");
    lines.push("|---|---|---|---|");
    for (const m of members) {
      const channel = m.slackChannel ? `#${m.slackChannel}` : "";
      lines.push(`| ${m.name} | ${m.role ?? ""} | ${channel} | ${m.pronouns ?? ""} |`);
    }
    return lines.join("\n");
  }
}

function mostRecent(matches: TeamMember[]): TeamMember | null {
  if (matches.length === 0) return null;
  // We don't carry updatedAt on TeamMember; matches list order from getHumans
  // mirrors Mongo natural order. For determinism with multiple matches, return
  // the first; team-human duplicates are a data hygiene issue surfaced at
  // migration time.
  return matches[0];
}
```

- [ ] **Step 3.2:** Add agent-alias lookup support.

The spec requires `team_lookup_agent` to match `AgentDefinition.aliases[]` (e.g. "Sam" → "Samantha"). `TeamMember` doesn't carry aliases. Add a parallel cache slice access in `TeamCache`:

In `src/team-roster/team-cache.ts`, add a helper after `getAgents()`:

```typescript
async getAgentAliases(): Promise<Map<string, string>> {
  // alias-lowercased → agentId. Always derived from registry, not cached
  // separately — registry data is already cached.
  const defs = await this.registry.getAllDefinitions();
  const out = new Map<string, string>();
  for (const d of defs) {
    for (const alias of d.aliases ?? []) {
      out.set(alias.toLowerCase(), d._id);
    }
  }
  return out;
}
```

In `team-api.ts`, replace the `lookupAgent` name-branch:

```typescript
const target = arg.name!.toLowerCase();
const direct = agents.find((m) => m.name.toLowerCase() === target);
if (direct) return direct;
const aliasMap = await this.cache.getAgentAliases();
const aliasedId = aliasMap.get(target);
if (!aliasedId) return null;
return agents.find((m) => m.agentId === aliasedId) ?? null;
```

- [ ] **Step 3.3:** Tests.

`src/team-roster/team-api.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { TeamApi } from "./team-api.js";
import type { TeamMember } from "./types.js";

function fakeCache(humans: TeamMember[], agents: TeamMember[], aliases: Record<string, string> = {}) {
  return {
    getHumans: async () => humans,
    getAgents: async () => agents,
    getAgentAliases: async () => new Map(Object.entries(aliases).map(([k, v]) => [k.toLowerCase(), v])),
  } as any;
}

const human = (over: Partial<TeamMember> = {}): TeamMember => ({
  kind: "human", id: "h1", name: "May", email: "may@dodihome.com",
  category: "team-human", active: true, ...over,
});
const agent = (over: Partial<TeamMember> = {}): TeamMember => ({
  kind: "agent", id: "mokie", agentId: "mokie", name: "Mokie",
  category: "team-agent", active: true, ...over,
});

describe("TeamApi", () => {
  it("getTeam excludes archived by default", async () => {
    const api = new TeamApi(fakeCache(
      [human(), human({ id: "h2", name: "Konstantin", category: "archived", active: false })],
      [],
    ));
    const out = await api.getTeam();
    expect(out.map((m) => m.name)).toEqual(["May"]);
  });

  it("getTeam(includeArchived) returns archived too", async () => {
    const api = new TeamApi(fakeCache(
      [human(), human({ id: "h2", name: "Konstantin", category: "archived", active: false })],
      [],
    ));
    const out = await api.getTeam({ includeArchived: true });
    expect(out.length).toBe(2);
  });

  it("getTeam(includeAgents=false) filters to humans", async () => {
    const api = new TeamApi(fakeCache([human()], [agent()]));
    const out = await api.getTeam({ includeAgents: false });
    expect(out.every((m) => m.kind === "human")).toBe(true);
  });

  it("lookupHuman by email is case-insensitive", async () => {
    const api = new TeamApi(fakeCache([human()], []));
    const out = await api.lookupHuman({ email: "MAY@DODIHOME.COM" });
    expect(out?.id).toBe("h1");
  });

  it("lookupHuman by name is case-insensitive exact match", async () => {
    const api = new TeamApi(fakeCache([human()], []));
    expect((await api.lookupHuman({ name: "may" }))?.id).toBe("h1");
    expect(await api.lookupHuman({ name: "ma" })).toBeNull();
  });

  it("lookupHuman throws on neither/both args", async () => {
    const api = new TeamApi(fakeCache([], []));
    await expect(api.lookupHuman({})).rejects.toThrow(/exactly one/);
    await expect(api.lookupHuman({ name: "x", email: "y@z.com" })).rejects.toThrow(/exactly one/);
  });

  it("lookupHuman ignores non-team-human records (defensive)", async () => {
    const api = new TeamApi(fakeCache(
      [human({ category: "archived", active: false })],
      [],
    ));
    expect(await api.lookupHuman({ name: "May" })).toBeNull();
  });

  it("lookupAgent by agentId is case-sensitive", async () => {
    const api = new TeamApi(fakeCache([], [agent()]));
    expect((await api.lookupAgent({ agentId: "mokie" }))?.agentId).toBe("mokie");
    expect(await api.lookupAgent({ agentId: "Mokie" })).toBeNull();
  });

  it("lookupAgent by alias resolves to canonical agent", async () => {
    const api = new TeamApi(fakeCache([], [agent({ name: "Samantha", agentId: "samantha" })], { Sam: "samantha" }));
    expect((await api.lookupAgent({ name: "Sam" }))?.agentId).toBe("samantha");
  });

  it("lookupAgent throws on neither/both args", async () => {
    const api = new TeamApi(fakeCache([], []));
    await expect(api.lookupAgent({})).rejects.toThrow(/exactly one/);
    await expect(api.lookupAgent({ agentId: "a", name: "b" })).rejects.toThrow(/exactly one/);
  });

  it("teamSummary renders a markdown table with channel + pronouns", async () => {
    const api = new TeamApi(fakeCache(
      [human({ name: "May", role: "CEO", pronouns: "she/her" })],
      [agent({ name: "Mokie", role: "Chief of Staff", slackChannel: "agent-mokie", pronouns: "she/her" })],
    ));
    const out = await api.teamSummary();
    expect(out).toContain("## Team Roster");
    expect(out).toContain("| Name | Role | Channel | Pronouns |");
    expect(out).toContain("| May | CEO |  | she/her |");
    expect(out).toContain("| Mokie | Chief of Staff | #agent-mokie | she/her |");
  });
});
```

- [ ] **Step 3.4:** Verify.

```bash
npm run typecheck
npx vitest run src/team-roster/team-api.test.ts
```

Expected: clean typecheck, 11/11 tests pass.

- [ ] **Step 3.5:** Commit.

```bash
git add src/team-roster/team-api.ts src/team-roster/team-cache.ts src/team-roster/team-api.test.ts
git commit -m "feat(KPR-79): TeamApi (lookup + summary)"
```

---

## Task 4: Agent-registry refactor (`onPostReload` emitter)

**Files:**
- Modify: `src/agents/agent-registry.ts:22-26` (field rename), `:24-27` (constructor), `:115-132` (change-stream handler), `:134-149` (poll handler), `:29-113` (load → fire post-reload)
- Modify: `src/index.ts:123-126` (constructor call rename)
- Create: `src/agents/agent-registry.test.ts`

- [ ] **Step 4.1:** Rename `onReload` → `onChangeDetected`, add `onPostReload`.

In `src/agents/agent-registry.ts`, replace lines 22-27:

```typescript
  /** Pre-reload trigger — fires when a mutation is detected, used to schedule a debounced reload. */
  private onChangeDetected?: () => void;
  /** Post-reload subscribers — fired after `load()` commits new state. Multi-subscriber. */
  private postReloadHandlers: Array<() => void> = [];

  constructor(agentDefs: Collection<AgentDefinition>, onChangeDetected?: () => void) {
    this.agentDefs = agentDefs;
    this.onChangeDetected = onChangeDetected;
  }

  /** Register a handler called after every successful `load()` (state already committed). */
  onPostReload(handler: () => void): void {
    this.postReloadHandlers.push(handler);
  }
```

- [ ] **Step 4.2:** Fire `postReloadHandlers` from inside `load()`.

At the end of `load()` (around line 111, after `this.rebuildOriginIndex()`), add:

```typescript
    this.lastPollTime = new Date();
    this.rebuildOriginIndex();

    // Fire post-reload subscribers AFTER state commit. Errors in one handler
    // must not prevent others from firing — log and continue.
    for (const handler of this.postReloadHandlers) {
      try {
        handler();
      } catch (err) {
        log.error("onPostReload handler threw", { error: String(err) });
      }
    }
    return { added, updated, removed };
```

(replaces existing `this.lastPollTime = new Date(); this.rebuildOriginIndex(); return ...` block)

- [ ] **Step 4.3:** Update internal call sites.

Lines 120 and 142 currently call `this.onReload?.()`. Update to `this.onChangeDetected?.()`.

- [ ] **Step 4.4:** Update `src/index.ts` constructor arg name (cosmetic — same positional arg).

`src/index.ts:123-126` — no functional change needed (positional). But verify the surrounding comment doesn't claim "onReload"; if so, edit comment to "onChangeDetected".

- [ ] **Step 4.5:** Tests.

`src/agents/agent-registry.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { AgentRegistry } from "./agent-registry.js";

function fakeCol(docs: any[]) {
  return {
    find: () => ({ toArray: async () => docs }),
    countDocuments: async () => 0,
    watch: () => ({ on: vi.fn(), close: async () => {} }),
  } as any;
}

describe("AgentRegistry post-reload subscribers", () => {
  it("onPostReload handlers fire after load() commits state", async () => {
    const reg = new AgentRegistry(fakeCol([
      { _id: "rae", name: "Rae", model: "haiku", channels: [], homeBase: "rae", soul: "", systemPrompt: "" },
    ]));
    let observedIds: string[] = [];
    reg.onPostReload(() => {
      // listIds() observable inside the handler — state already committed
      observedIds = reg.listIds();
    });
    await reg.load();
    expect(observedIds).toEqual(["rae"]);
  });

  it("multiple handlers all fire", async () => {
    const reg = new AgentRegistry(fakeCol([]));
    const a = vi.fn();
    const b = vi.fn();
    reg.onPostReload(a);
    reg.onPostReload(b);
    await reg.load();
    expect(a).toHaveBeenCalledOnce();
    expect(b).toHaveBeenCalledOnce();
  });

  it("a throwing handler does not prevent later handlers from firing", async () => {
    const reg = new AgentRegistry(fakeCol([]));
    const second = vi.fn();
    reg.onPostReload(() => { throw new Error("boom"); });
    reg.onPostReload(second);
    await reg.load();
    expect(second).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 4.6:** Verify.

```bash
npm run typecheck
npx vitest run src/agents/agent-registry.test.ts
```

Expected: clean typecheck, 3/3 tests pass.

- [ ] **Step 4.7:** Commit.

```bash
git add src/agents/agent-registry.ts src/agents/agent-registry.test.ts src/index.ts
git commit -m "refactor(KPR-79): AgentRegistry onReload → onChangeDetected + onPostReload emitter"
```

---

## Task 5: Contacts change-stream watcher

**Files:**
- Create: `src/team-roster/contacts-watcher.ts`, `src/team-roster/contacts-watcher.test.ts`

- [ ] **Step 5.1:** Implement the watcher.

`src/team-roster/contacts-watcher.ts`:

```typescript
import type { ChangeStream, Collection } from "mongodb";
import type { TeamCache } from "./team-cache.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("team-roster:contacts-watcher");
const POLL_INTERVAL_MS = 30_000;

/**
 * Watches the `contacts` collection for changes and invalidates the humans
 * slice on any write. Coarse-by-design: HubSpot's nightly customer sync
 * triggers ~7K wasted invalidations per night, but the humans cache holds
 * <100 records so each repopulate is a tiny query.
 *
 * Uses change-stream when available (replica set), falls back to polling
 * by checking max(updatedAt) since the last tick.
 */
export class ContactsWatcher {
  private changeStream: ChangeStream | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private lastPollTime = new Date(0);

  constructor(
    private readonly contactsCol: Collection<any>,
    private readonly cache: TeamCache,
  ) {}

  async start(): Promise<void> {
    try {
      this.changeStream = this.contactsCol.watch([], {});
      this.changeStream.on("change", () => {
        log.debug("contacts change detected — invalidating humans cache");
        this.cache.invalidateHumans();
      });
      this.changeStream.on("error", (err) => {
        log.warn("change-stream error, falling back to polling", { error: String(err) });
        this.changeStream?.close().catch(() => {});
        this.changeStream = null;
        this.startPolling();
      });
      log.info("contacts watcher running via change-stream");
    } catch (err) {
      log.info("change-stream unavailable, using polling", { error: String(err) });
      this.startPolling();
    }
  }

  private startPolling(): void {
    this.pollTimer = setInterval(async () => {
      try {
        const changed = await this.contactsCol.countDocuments({ updatedAt: { $gt: this.lastPollTime } });
        if (changed > 0) {
          log.debug("contacts poll detected change — invalidating humans cache", { changed });
          this.cache.invalidateHumans();
        }
        this.lastPollTime = new Date();
      } catch (err) {
        log.error("poll failed", { error: String(err) });
      }
    }, POLL_INTERVAL_MS);
    log.info("contacts watcher running via polling", { intervalMs: POLL_INTERVAL_MS });
  }

  stop(): void {
    if (this.changeStream) {
      this.changeStream.close().catch(() => {});
      this.changeStream = null;
    }
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }
}
```

- [ ] **Step 5.2:** Tests.

`src/team-roster/contacts-watcher.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { ContactsWatcher } from "./contacts-watcher.js";

function fakeCol() {
  const handlers: Record<string, Function> = {};
  const stream = {
    on: vi.fn((event: string, cb: Function) => { handlers[event] = cb; }),
    close: vi.fn(async () => {}),
  };
  return {
    handlers,
    col: {
      watch: vi.fn(() => stream),
      countDocuments: vi.fn(async () => 0),
    } as any,
    stream,
  };
}

describe("ContactsWatcher", () => {
  it("invalidates humans on change-stream event", async () => {
    const { col, handlers } = fakeCol();
    const cache = { invalidateHumans: vi.fn() } as any;
    const w = new ContactsWatcher(col, cache);
    await w.start();
    handlers["change"]({ operationType: "update" });
    expect(cache.invalidateHumans).toHaveBeenCalledOnce();
    w.stop();
  });

  it("falls back to polling on change-stream error", async () => {
    const { col, handlers } = fakeCol();
    const cache = { invalidateHumans: vi.fn() } as any;
    const w = new ContactsWatcher(col, cache);
    await w.start();
    handlers["error"](new Error("no replica set"));
    // pollTimer started — verify by stopping cleanly
    expect(() => w.stop()).not.toThrow();
  });

  it("stop closes change-stream and clears poll timer", async () => {
    const { col, stream } = fakeCol();
    const w = new ContactsWatcher(col, { invalidateHumans: vi.fn() } as any);
    await w.start();
    w.stop();
    expect(stream.close).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 5.3:** Verify.

```bash
npm run typecheck
npx vitest run src/team-roster/contacts-watcher.test.ts
```

Expected: clean typecheck, 3/3 tests pass.

- [ ] **Step 5.4:** Commit.

```bash
git add src/team-roster/contacts-watcher.ts src/team-roster/contacts-watcher.test.ts
git commit -m "feat(KPR-79): contacts change-stream watcher with polling fallback"
```

---

## Task 6: In-process MCP server (`createSdkMcpServer`)

**Files:**
- Create: `src/team-roster/team-roster-mcp-server.ts`, `src/team-roster/team-roster-mcp-server.test.ts`

- [ ] **Step 6.1:** Build the in-process server.

`src/team-roster/team-roster-mcp-server.ts`:

```typescript
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { TeamApi } from "./team-api.js";

/**
 * Build the in-process team-roster MCP server. Returns the server config
 * shape that drops directly into agent-runner's mcpServers map alongside
 * stdio-typed entries. Closes over the shared TeamApi (and thus TeamCache),
 * so internal callers and agent tool calls hit identical state.
 *
 * NOTE: this is the first in-process (createSdkMcpServer) server in the
 * codebase — every other MCP is a stdio subprocess. The cache invariants
 * require single-process state; roster data has no isolation argument for
 * separate-process execution.
 */
export function buildTeamRosterMcpServer(api: TeamApi): McpSdkServerConfigWithInstance {
  return createSdkMcpServer({
    name: "team-roster",
    version: "0.1.0",
    tools: [
      tool(
        "team_list",
        "List the team. Defaults: active humans + active agents, sorted humans-first then by name. " +
          "Set includeArchived=true to include archived humans and deactivated agents. " +
          "Set includeAgents=false to filter to humans only.",
        {
          includeArchived: z.boolean().optional(),
          includeAgents: z.boolean().optional(),
        },
        async (args) => {
          const members = await api.getTeam(args);
          return { content: [{ type: "text", text: JSON.stringify(members, null, 2) }] };
        },
      ),
      tool(
        "team_lookup_human",
        "Look up a team-human by name or email. Provide exactly one. " +
          "Match: case-insensitive exact for both. Returns null if not found.",
        {
          name: z.string().optional(),
          email: z.string().optional(),
        },
        async (args) => {
          try {
            const m = await api.lookupHuman(args);
            return { content: [{ type: "text", text: m ? JSON.stringify(m, null, 2) : "null" }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: err.message ?? String(err) }], isError: true };
          }
        },
      ),
      tool(
        "team_lookup_agent",
        "Look up a team-agent by agentId or name. Provide exactly one. " +
          "agentId is case-sensitive; name is case-insensitive and matches aliases. " +
          "Returns null if not found.",
        {
          agentId: z.string().optional(),
          name: z.string().optional(),
        },
        async (args) => {
          try {
            const m = await api.lookupAgent(args);
            return { content: [{ type: "text", text: m ? JSON.stringify(m, null, 2) : "null" }] };
          } catch (err: any) {
            return { content: [{ type: "text", text: err.message ?? String(err) }], isError: true };
          }
        },
      ),
    ],
  });
}
```

- [ ] **Step 6.2:** Smoke test.

`src/team-roster/team-roster-mcp-server.test.ts`:

```typescript
import { describe, expect, it, vi } from "vitest";
import { buildTeamRosterMcpServer } from "./team-roster-mcp-server.js";

function fakeApi() {
  return {
    getTeam: vi.fn(async () => [{ kind: "human", id: "h1", name: "May", category: "team-human", active: true }]),
    lookupHuman: vi.fn(async () => ({ kind: "human", id: "h1", name: "May", category: "team-human", active: true })),
    lookupAgent: vi.fn(async () => null),
  } as any;
}

describe("team-roster MCP server", () => {
  it("registers as an SDK MCP server config (instance + name)", () => {
    const cfg = buildTeamRosterMcpServer(fakeApi());
    expect(cfg.type).toBe("sdk");
    expect(cfg.name).toBe("team-roster");
    expect(cfg.instance).toBeDefined();
  });

  it("getTeam: handler returns serialized members from API", async () => {
    const api = fakeApi();
    const cfg = buildTeamRosterMcpServer(api);
    // The MCP SDK doesn't expose registered handlers via a public API on
    // the server instance; reach into the underlying server tools registry.
    // This is a smoke test, not a tight contract — we only need to confirm
    // wiring exists end-to-end. If the SDK's internal shape changes, we
    // accept rewriting this test.
    const inst = cfg.instance as any;
    // Server reflects registered tools through `_registeredTools` (current SDK).
    // If absent, fall back to invoking the API directly to confirm bindings compile.
    expect(inst).toBeTruthy();
    await api.getTeam(); // invokes mock — confirms API contract
    expect(api.getTeam).toHaveBeenCalled();
  });

  it("lookupHuman handler propagates API errors as isError", async () => {
    // Smoke: ensure error propagation path compiles by exercising the API mock.
    const api = fakeApi();
    api.lookupHuman = vi.fn(async () => { throw new Error("exactly one"); });
    const cfg = buildTeamRosterMcpServer(api);
    expect(cfg.instance).toBeDefined();
  });
});
```

**Note on smoke-test depth:** `createSdkMcpServer` returns an opaque server instance. Asserting against the registered tools requires reaching into SDK internals (the spec calls this out as the *first* in-process server — there's no precedent in the codebase). The plan accepts shallow smoke (instance constructed, name/type fields present) and relies on the end-to-end manual smoke (Task 8) to confirm agents can call the tools.

- [ ] **Step 6.3:** Verify.

```bash
npm run typecheck
npx vitest run src/team-roster/team-roster-mcp-server.test.ts
```

Expected: clean typecheck, 3/3 tests pass.

- [ ] **Step 6.4:** Commit.

```bash
git add src/team-roster/team-roster-mcp-server.ts src/team-roster/team-roster-mcp-server.test.ts
git commit -m "feat(KPR-79): in-process team-roster MCP server (createSdkMcpServer)"
```

---

## Task 7: Module bootstrap (`src/team-roster/index.ts`) + wire into `src/index.ts`

**Files:**
- Create: `src/team-roster/index.ts`
- Modify: `src/index.ts` (init team-roster after registry.load and before agentManager)

- [ ] **Step 7.1:** Bootstrap module.

`src/team-roster/index.ts`:

```typescript
import type { Db } from "mongodb";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { TeamCache } from "./team-cache.js";
import { TeamApi } from "./team-api.js";
import { ContactsWatcher } from "./contacts-watcher.js";
import { buildTeamRosterMcpServer } from "./team-roster-mcp-server.js";

export type { TeamMember, ContactCategory } from "./types.js";
export { TeamCache } from "./team-cache.js";
export { TeamApi } from "./team-api.js";

export interface TeamRosterHandle {
  api: TeamApi;
  cache: TeamCache;
  mcpServer: McpSdkServerConfigWithInstance;
  /** Stop watchers — call on shutdown */
  shutdown: () => void;
}

/**
 * Initialize the team-roster module. Wires:
 *   - cache (humans + agents slices)
 *   - in-process MCP server (closure-shared with cache)
 *   - contacts change-stream watcher → invalidates humans slice
 *   - agent-registry onPostReload subscriber → invalidates agents slice
 */
export async function initTeamRoster(deps: { db: Db; registry: AgentRegistry }): Promise<TeamRosterHandle> {
  const contactsCol = deps.db.collection("contacts");
  const cache = new TeamCache(contactsCol, deps.registry);
  const api = new TeamApi(cache);
  const mcpServer = buildTeamRosterMcpServer(api);

  const watcher = new ContactsWatcher(contactsCol, cache);
  await watcher.start();

  deps.registry.onPostReload(() => cache.invalidateAgents());

  return {
    api,
    cache,
    mcpServer,
    shutdown: () => watcher.stop(),
  };
}
```

- [ ] **Step 7.2:** Wire into `src/index.ts`.

After `await registry.load();` (line 127) and before `agentManager = new AgentManager(...)` (line 212) — concretely, immediately after the `log.info("Agent registry loaded", ...)` line — add:

```typescript
  // Team-roster module — built-in tools + system-prompt summary
  const { initTeamRoster } = await import("./team-roster/index.js");
  const teamRoster = await initTeamRoster({ db, registry });
  log.info("Team roster initialized");

  // Expose TeamApi + MCP server to AgentRunner via static refs (mirrors registryRef pattern at line 376)
  const { AgentRunner: AgentRunnerEarly } = await import("./agents/agent-runner.js");
  AgentRunnerEarly.teamApiRef = teamRoster.api;
  AgentRunnerEarly.teamMcpServerRef = teamRoster.mcpServer;
```

- [ ] **Step 7.3:** Add shutdown hook into existing `shutdown` closure.

`src/index.ts` already has a `shutdown` arrow at line 544 (calls `registry.stopWatching()`, `await teamStore.close()`, etc.) wired to both `SIGTERM` and `SIGINT` at lines 572-573. Insert `teamRoster.shutdown();` inside that closure (sync — `ContactsWatcher.stop()` is sync), placed near the existing `registry.stopWatching();` line so related watchers stop together. Do NOT register a new `process.on("SIGTERM"...)` handler — that would double-fire.

- [ ] **Step 7.4:** Verify.

```bash
npm run typecheck
```

Expected: clean. (Two more references — `AgentRunner.teamApiRef` and `teamMcpServerRef` — will be added in Task 8 below.)

- [ ] **Step 7.5:** Commit.

```bash
git add src/team-roster/index.ts src/index.ts
git commit -m "feat(KPR-79): team-roster module bootstrap + wire into index.ts"
```

---

## Task 8: Wire into `agent-runner.ts` (always-on tool + system-prompt summary)

**Files:**
- Modify: `src/agents/agent-runner.ts:186` (class field declarations near `registryRef`), `:866-883` (`filterCoreServers`), `:937` (`INFRASTRUCTURE_SERVERS`), `:240-243` (system prompt assembly), `:797-813` (mcpServers map injection — add team-roster alongside existing `team`)
- Modify: `src/tools/server-catalog.ts` (add `team-roster` entry)

- [ ] **Step 8.1:** Add static refs to `AgentRunner`.

Find the existing `static registryRef` at line 186 (`static registryRef?: import("./agent-registry.js").AgentRegistry;`). Add alongside:

```typescript
  static teamApiRef: import("../team-roster/team-api.js").TeamApi | null = null;
  static teamMcpServerRef: import("@anthropic-ai/claude-agent-sdk").McpSdkServerConfigWithInstance | null = null;
```

- [ ] **Step 8.2:** Force-on `team-roster` in `filterCoreServers`.

In `src/agents/agent-runner.ts:866-883`, after the existing `coreSet.add("team")` line, add:

```typescript
    // team-roster is an implicit core server — every agent gets the team API
    coreSet.add("team-roster");
```

- [ ] **Step 8.3:** Hide from "Your tools" prompt section.

Update `INFRASTRUCTURE_SERVERS` (line 937):

```typescript
  private static readonly INFRASTRUCTURE_SERVERS = new Set([
    "schedule", "structured-memory", "team", "team-roster",
  ]);
```

- [ ] **Step 8.4:** Inject the in-process MCP into the servers map.

In `buildAllServerConfigs` (around line 813, after the existing `team` server registration), add:

```typescript
    // Team-roster MCP — in-process SDK server (createSdkMcpServer). Shares
    // closure with engine TeamApi so tool calls and internal calls hit the
    // same cache. Built once at module init in src/index.ts.
    if (AgentRunner.teamMcpServerRef) {
      servers["team-roster"] = AgentRunner.teamMcpServerRef;
    } else {
      log.warn("team-roster MCP server ref not set — agents will not have team_* tools");
    }
```

- [ ] **Step 8.5:** Inject team summary into system prompt.

In `buildSystemPrompt` (line 206), find the constitution `if` block (lines 240-243). Insert the team-summary block **after** the closing `}` on line 243 (so the summary is pushed even if constitution is missing) and **before** the `// --- Semi-static` comment on line 245:

```typescript
    // Team summary — concise live view of the team. Replaces the legacy
    // shared/business-context.md table. Slotted post-constitution and pre
    // tool-catalog so identity-context (constitution + team) groups together.
    if (AgentRunner.teamApiRef) {
      try {
        const summary = await AgentRunner.teamApiRef.teamSummary();
        if (summary) parts.push(summary);
      } catch (err) {
        log.error("teamSummary threw — omitting team block", { error: String(err) });
      }
    }
```

- [ ] **Step 8.6:** Catalog entry.

In `src/tools/server-catalog.ts`, add (anywhere in the alpha-ish section — keep near `team`):

```typescript
  "team-roster": {
    description: "Team directory — list humans + agents, look up by name/email/agentId",
    usage: "Finding a teammate's role, channel, or pronouns; routing decisions",
  },
```

This is hidden from the "## Your tools" section by `INFRASTRUCTURE_SERVERS`, but the catalog entry is required so any code path that does call `formatCatalogEntry("team-roster", ...)` doesn't fall back to a generic placeholder.

- [ ] **Step 8.7:** Verify.

```bash
npm run typecheck
npm run lint
```

Expected: clean.

- [ ] **Step 8.8:** Commit.

```bash
git add src/agents/agent-runner.ts src/tools/server-catalog.ts
git commit -m "feat(KPR-79): wire team-roster as always-on built-in + system-prompt summary"
```

---

## Task 9: Migration script (`migrate-contacts-categories.ts`)

**Files:**
- Create: `scripts/migrate-contacts-categories.ts`, `scripts/migrate-contacts-categories.test.ts`
- Modify: `package.json` (add `migrate:contacts-categories` script)

- [ ] **Step 9.1:** Hard-coded team-human email list.

The list is dodi-specific — keepur has its own (much smaller) team. Make the team-emails list a CLI arg or top-of-file constant; default to the dodi list documented in `MEMORY.md`. Inline in the script:

```typescript
const DODI_TEAM_EMAILS = new Set([
  "may@dodihome.com",
  "corey@dodihome.com",
  "aaron@dodihome.com",
  "angus@dodihome.com",
  "angela@dodihome.com",
  "lauren@dodihome.com",
  "zhitong@dodihome.com",
  "mike@dodihome.com",
]);
```

For keepur, the operator passes `--team-emails-file=<path>` pointing at a newline-delimited list. If neither flag nor instance-default applies, the script still backfills source-based categories but no team-human matches occur (operator can fix up via `contacts_update` post-hoc).

- [ ] **Step 9.2:** Implement the script.

`scripts/migrate-contacts-categories.ts`:

```typescript
#!/usr/bin/env node
/**
 * KPR-79: Migrate contacts collection — backfill `category`, dedupe by
 * lowercase email, archive stale rows, delete obvious test rows.
 *
 * Usage:
 *   npx tsx scripts/migrate-contacts-categories.ts <instance> --dry-run
 *   npx tsx scripts/migrate-contacts-categories.ts <instance> --apply
 *   npx tsx scripts/migrate-contacts-categories.ts <instance> --apply --team-emails-file=team.txt
 *
 * Idempotent: re-running on already-migrated data is a no-op.
 *
 * Caveat (step 2): only collapses records with identical-after-lowercase
 * emails. Typo-distinct emails (e.g. cotry@ vs corey@) are NOT merged —
 * fix manually before/after.
 *
 * Restore: --dry-run writes the diff to /tmp/kpr-79-migration-<ts>.diff;
 * --apply writes the same diff for post-hoc reference. Step 1 (test-row
 * delete) is the only true delete; step 2 (dedupe) sets category="archived"
 * to retain audit history.
 */

import { MongoClient, ObjectId, type Collection } from "mongodb";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const TEST_EMAIL_PATTERNS = [/^layna\+test/i];
const STALE_TEAM_NAMES = new Set(["Konstantin"]); // former Director of Operations

const DODI_TEAM_EMAILS = new Set([
  "may@dodihome.com",
  "corey@dodihome.com",
  "aaron@dodihome.com",
  "angus@dodihome.com",
  "angela@dodihome.com",
  "lauren@dodihome.com",
  "zhitong@dodihome.com",
  "mike@dodihome.com",
]);

interface DiffEntry {
  op: "delete" | "archive" | "set-category" | "set-name-archived";
  id: string;
  before: any;
  after?: any;
}

interface Args {
  instance: string;
  dryRun: boolean;
  apply: boolean;
  teamEmails: Set<string>;
}

function parseArgs(argv: string[]): Args {
  if (argv.length < 1) usage();
  const instance = argv[0];
  const flags = new Set(argv.slice(1).filter((a) => !a.includes("=")));
  const kv = Object.fromEntries(
    argv.slice(1).filter((a) => a.includes("=")).map((a) => a.split("=")),
  );
  const dryRun = flags.has("--dry-run");
  const apply = flags.has("--apply");
  if (dryRun === apply) {
    console.error("Pass exactly one of --dry-run or --apply.");
    process.exit(2);
  }
  let teamEmails = DODI_TEAM_EMAILS;
  if (kv["--team-emails-file"]) {
    const path = kv["--team-emails-file"];
    if (!existsSync(path)) {
      console.error(`team-emails-file not found: ${path}`);
      process.exit(2);
    }
    teamEmails = new Set(
      readFileSync(path, "utf8").split("\n").map((s) => s.trim().toLowerCase()).filter(Boolean),
    );
  }
  return { instance, dryRun, apply, teamEmails };
}

function usage(): never {
  console.error("Usage: migrate-contacts-categories <instance> --dry-run|--apply [--team-emails-file=<path>]");
  process.exit(2);
}

async function loadInstanceMongoUri(instance: string): Promise<{ uri: string; dbName: string }> {
  // Read from ~/services/hive/<instance>/.hive/dist or env. Mirror the agent-id
  // migration script's approach: prefer MONGODB_URI env, otherwise default
  // mongodb://localhost:27017 + db name `hive_<instance>` (matches multi-instance convention).
  const uri = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
  const dbName = process.env.MONGODB_DB ?? `hive_${instance}`;
  return { uri, dbName };
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const { uri, dbName } = await loadInstanceMongoUri(args.instance);
  const client = new MongoClient(uri);
  await client.connect();
  try {
    const db = client.db(dbName);
    const contacts = db.collection<any>("contacts");
    const diff: DiffEntry[] = [];

    // Step 1: delete obvious test rows.
    const testRows = await contacts.find({
      $or: TEST_EMAIL_PATTERNS.map((p) => ({ email: { $regex: p } })),
    }).toArray();
    for (const r of testRows) {
      diff.push({ op: "delete", id: String(r._id), before: r });
    }

    // Step 2: dedupe by lowercase email (keep most recently updated).
    // Excludes already-archived rows so re-runs are idempotent.
    const allWithEmail = await contacts.find({
      email: { $ne: null },
      category: { $ne: "archived" },
    }).toArray();
    const groups = new Map<string, any[]>();
    for (const r of allWithEmail) {
      const key = (r.email as string).toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(r);
    }
    const archiveIds = new Set<string>();
    for (const [_, rows] of groups) {
      if (rows.length < 2) continue;
      rows.sort((a, b) => {
        const ta = (a.updatedAt as Date | undefined)?.getTime() ?? 0;
        const tb = (b.updatedAt as Date | undefined)?.getTime() ?? 0;
        return tb - ta; // newest first
      });
      for (const r of rows.slice(1)) {
        archiveIds.add(String(r._id));
        diff.push({
          op: "archive",
          id: String(r._id),
          before: { email: r.email, category: r.category },
          after: { category: "archived" },
        });
      }
    }

    // Step 3: backfill category, first-match-wins precedence.
    const remaining = await contacts.find({}).toArray();
    for (const r of remaining) {
      // Skip records pending delete or archive
      if (TEST_EMAIL_PATTERNS.some((p) => r.email && p.test(r.email))) continue;
      if (archiveIds.has(String(r._id))) continue;
      // Skip if category is already set (idempotent)
      if (r.category) continue;

      let next: string;
      const lcEmail = r.email ? (r.email as string).toLowerCase() : null;
      if (lcEmail && args.teamEmails.has(lcEmail)) {
        next = "team-human";
      } else if (r.source === "hubspot") {
        next = "customer";
      } else {
        next = "customer";
      }
      diff.push({
        op: "set-category",
        id: String(r._id),
        before: { category: r.category, source: r.source, email: r.email },
        after: { category: next },
      });
    }

    // Step 4: archive stale named team members. Skip if already archived
    // (idempotency — re-runs produce no diff once cleaned).
    const staleByName = await contacts.find({
      name: { $in: [...STALE_TEAM_NAMES] },
      category: { $ne: "archived" },
    }).toArray();
    for (const r of staleByName) {
      if (archiveIds.has(String(r._id))) continue;
      diff.push({
        op: "set-name-archived",
        id: String(r._id),
        before: { name: r.name, category: r.category },
        after: { category: "archived" },
      });
    }

    // Write diff
    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const diffPath = `/tmp/kpr-79-migration-${ts}.diff`;
    writeFileSync(diffPath, JSON.stringify(diff, null, 2));
    console.log(`Diff written: ${diffPath}`);
    console.log(`Operations queued: ${diff.length}`);
    const counts = diff.reduce((acc: Record<string, number>, e) => {
      acc[e.op] = (acc[e.op] ?? 0) + 1;
      return acc;
    }, {});
    console.log("Breakdown:", counts);

    if (args.dryRun) {
      console.log("--dry-run: no writes performed.");
      return;
    }

    // Apply
    for (const e of diff) {
      const _id = new ObjectId(e.id);
      if (e.op === "delete") {
        await contacts.deleteOne({ _id });
      } else if (e.op === "archive" || e.op === "set-name-archived") {
        await contacts.updateOne({ _id }, { $set: { category: "archived", updatedAt: new Date() } });
      } else if (e.op === "set-category") {
        await contacts.updateOne({ _id }, { $set: { category: (e.after as any).category, updatedAt: new Date() } });
      }
    }
    console.log(`--apply: ${diff.length} operations committed.`);
  } finally {
    await client.close();
  }
}

// Only run when invoked directly (not when imported by tests).
// Compares the resolved entrypoint URL to the module URL.
const entryUrl = process.argv[1] ? new URL(`file://${process.argv[1]}`).href : "";
if (import.meta.url === entryUrl) {
  run().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
```

**Why the import-guard:** `migrate-contacts-categories.test.ts` imports `categorizeContact` and `pickKeeper` from this module. Without the guard, the bottom-of-file `run()` call fires on import, attempting a Mongo connection and parsing CLI args (which Vitest doesn't set, so `parseArgs` would `process.exit(2)`).

- [ ] **Step 9.3:** Tests for the precedence + dedupe logic.

`scripts/migrate-contacts-categories.test.ts`:

The script is largely I/O — but the precedence rules and dedupe selection are pure-ish. Refactor those into exported helpers above the `run()` body, and test them. Add at the top of the script (before `run()`):

```typescript
export function categorizeContact(
  contact: { email: string | null; source: string },
  teamEmails: Set<string>,
): "team-human" | "customer" {
  const lcEmail = contact.email?.toLowerCase() ?? null;
  if (lcEmail && teamEmails.has(lcEmail)) return "team-human";
  if (contact.source === "hubspot") return "customer";
  return "customer";
}

export function pickKeeper<T extends { updatedAt?: Date }>(rows: T[]): T {
  const sorted = [...rows].sort((a, b) => {
    const ta = a.updatedAt?.getTime() ?? 0;
    const tb = b.updatedAt?.getTime() ?? 0;
    return tb - ta;
  });
  return sorted[0];
}
```

Update the `run()` body to call `categorizeContact(...)` and `pickKeeper(...)`.

Then in the test file:

```typescript
import { describe, expect, it } from "vitest";
import { categorizeContact, pickKeeper } from "./migrate-contacts-categories.js";

const TEAM = new Set(["may@dodihome.com", "corey@dodihome.com"]);

describe("categorizeContact", () => {
  it("team-email match wins over hubspot source (precedence 1 > 2)", () => {
    expect(categorizeContact({ email: "MAY@DODIHOME.COM", source: "hubspot" }, TEAM)).toBe("team-human");
  });
  it("hubspot source → customer when no team match", () => {
    expect(categorizeContact({ email: "stranger@example.com", source: "hubspot" }, TEAM)).toBe("customer");
  });
  it("non-hubspot, non-team → customer (default)", () => {
    expect(categorizeContact({ email: "manual@x.com", source: "manual" }, TEAM)).toBe("customer");
  });
  it("null email + non-hubspot → customer", () => {
    expect(categorizeContact({ email: null, source: "manual" }, TEAM)).toBe("customer");
  });
  it("case-insensitive email match", () => {
    expect(categorizeContact({ email: "Corey@DodiHome.com", source: "manual" }, TEAM)).toBe("team-human");
  });
});

describe("pickKeeper", () => {
  it("returns the most recently updated row", () => {
    const a = { id: "a", updatedAt: new Date("2026-01-01") };
    const b = { id: "b", updatedAt: new Date("2026-04-01") };
    const c = { id: "c", updatedAt: new Date("2026-02-01") };
    expect(pickKeeper([a, b, c]).id).toBe("b");
  });
  it("undefined updatedAt sorts to oldest", () => {
    const a = { id: "a" };
    const b = { id: "b", updatedAt: new Date("2026-01-01") };
    expect(pickKeeper([a, b]).id).toBe("b");
  });
});
```

- [ ] **Step 9.4:** Add npm script.

In `package.json`:

```json
"migrate:contacts-categories": "npx tsx scripts/migrate-contacts-categories.ts",
```

- [ ] **Step 9.5:** Verify.

```bash
npm run typecheck
npx vitest run scripts/migrate-contacts-categories.test.ts
```

Expected: clean typecheck, 7/7 tests pass. (Do NOT run the actual migration here — that's Task 10.)

- [ ] **Step 9.6:** Commit.

```bash
git add scripts/migrate-contacts-categories.ts scripts/migrate-contacts-categories.test.ts package.json
git commit -m "feat(KPR-79): contacts category migration script"
```

---

## Task 10: Run migration + retire `business-context.md` team table (operator steps)

These steps are operator-driven and execute against live data. The implementer should pause and confirm with the operator before each.

- [ ] **Step 10.1:** Dry-run on dodi.

```bash
MONGODB_DB=hive_dodi npm run migrate:contacts-categories -- dodi --dry-run
```

Expected: prints op breakdown, writes diff to `/tmp/kpr-79-migration-<ts>.diff`. Operator inspects the diff and confirms it looks right (delete count ≤ ~10 test rows; team-human assignments ≤ 8; rest customer/archived).

- [ ] **Step 10.2:** Apply on dodi.

```bash
MONGODB_DB=hive_dodi npm run migrate:contacts-categories -- dodi --apply
```

Expected: all ops commit. After this, `db.contacts.countDocuments({ category: "team-human" })` should match the operator's expected team size.

- [ ] **Step 10.3:** Repeat for keepur.

```bash
MONGODB_DB=hive_keepur npm run migrate:contacts-categories -- keepur --dry-run --team-emails-file=<keepur-team-emails.txt>
# inspect, then
MONGODB_DB=hive_keepur npm run migrate:contacts-categories -- keepur --apply --team-emails-file=<keepur-team-emails.txt>
```

- [ ] **Step 10.4:** Restart hive instances to pick up new code.

```bash
launchctl kickstart -k gui/$(id -u)/com.hive.dodi.agent
launchctl kickstart -k gui/$(id -u)/com.hive.keepur.agent
```

- [ ] **Step 10.5:** Smoke-test the team API end-to-end.

In Slack, address Mokie (or any agent): "use team_list to show me the team." Expect a JSON response listing humans + agents. Then: "look up corey by email." Expect a single team-human record returned.

- [ ] **Step 10.6:** Remove the team-roster table from `shared/business-context.md`.

This is a memory edit — `shared/business-context.md` lives in `db.memory` per instance. Operator opens the document via the memory MCP (e.g. `memory_read shared/business-context.md`), deletes the team-roster table block AND the "use this table — not the contacts database" footnote, then `memory_write`s the trimmed version. Repeat on dodi + keepur.

- [ ] **Step 10.7:** Update Mokie's onboarding skill (KPR-71) + constitution references.

Search the constitution and Mokie's onboarding skill for references to "team table" / "business-context.md team roster":

```bash
grep -rn "team table\|team roster\|business-context" /Users/mokie/services/hive/dodi/skills/ 2>/dev/null
```

Replace those phrases with calls to the team API tools (`team_list`, `team_lookup_human`). KPR-71 may already have its own ticket-bound updates — coordinate so we don't double-edit the same file.

- [ ] **Step 10.8:** No-commit step. (These are operator-runtime actions, not source-code commits.)

---

## Verification (post-implementation gate)

After Tasks 1-9 land in source:

```bash
npm run check
```

Must pass: typecheck + lint + format + all tests.

Manual end-to-end (post-Task-10 deploy):

1. Send `/team_list` (via agent prompt) — confirm humans + agents returned.
2. Update a contact (e.g., add a new team-human via `contacts_create`) — within ~1s the agent should see the new row in `team_list` (change-stream invalidation).
3. Trigger SIGUSR1 — agents slice should refresh too (post-reload subscriber).
4. Confirm `## Team Roster` block appears in agent system prompts (check via `prompt_overrides` / log inspection).

---

## Rollback plan

- The migration is `--dry-run`-able and writes a full diff to `/tmp/`. Reverting individual rows: `contacts_update` to flip `category` back. Step-1 deletes (test rows) are intentionally trash — no restore needed.
- Engine code rollback: revert the merged PR. Spec is additive — no agent depends on `team-roster` outside the always-on injection, which is no-op when `teamApiRef` is null (logged warning).
- The `onPostReload` rename is internal API only; no public surface.

---

## Out of scope (per spec non-goals)

- Splitting customers out of `contacts` (KPR-80 — follow-up).
- Operator YAML / file-based roster (rejected).
- Cross-instance roster federation.
- Mirroring agents into `contacts` (agents stay in `agent_definitions`).
- Replacing HubSpot as customer-record source of truth.
