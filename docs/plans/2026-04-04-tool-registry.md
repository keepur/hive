# Tool Registry — Server-Level Discoverability Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Enrich server-level metadata with usage guidance and inject both core + delegate servers into the system prompt so agents know what they have and when to use each server.

**Architecture:** Replace the flat `NAMESPACE_DESCRIPTIONS` map with a typed `ServerCatalog` that carries `description`, `usage`, and `notFor` per server. Plugin servers get the same fields in `plugin.yaml`. The system prompt builder gains a "Your tools" section for core servers alongside the existing "Available via subagents" section for delegates.

**Tech Stack:** TypeScript, YAML (plugin manifests)

---

### File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/tools/server-catalog.ts` | Create | `ServerCatalogEntry` type + core server catalog (replaces `namespace-descriptions.ts`) |
| `src/delegate/namespace-descriptions.ts` | Delete | Replaced by `src/tools/server-catalog.ts` |
| `src/plugins/types.ts` | Modify | Add `usage?` and `notFor?` to `PluginMcpServer` |
| `src/plugins/plugin-loader.ts` | Modify | Parse `usage` and `not-for` fields from YAML |
| `plugins/dodi/plugin.yaml` | Modify | Add `description` fields (self-documenting fallback) |
| `src/agents/agent-runner.ts` | Modify | Import from new location, `getServerDescription()` → `getServerCatalogEntry()`, prompt builder adds core tools section |
| `src/agents/agent-runner.test.ts` | Modify | Update tests for new prompt section and import |

---

### Task 1: Create ServerCatalog type and core server catalog

**Files:**
- Create: `src/tools/server-catalog.ts`

- [ ] **Step 1:** Create directory and file

Run: `mkdir -p src/tools`

- [ ] **Step 2:** Define `ServerCatalogEntry` type and core server catalog

```typescript
export interface ServerCatalogEntry {
  /** What this server does (shown in prompt) */
  description: string;
  /** When to use this server — guidance for the agent */
  usage?: string;
  /** Common misuse — "for X, use Y instead" */
  notFor?: string;
}

/**
 * Core server catalog — metadata for built-in MCP servers.
 * Plugin servers define their own metadata in plugin.yaml manifests.
 */
export const SERVER_CATALOG: Record<string, ServerCatalogEntry> = {
  "hubspot-crm": {
    description: "Search and manage CRM — deals, contacts, companies, notes, tasks, activities",
    usage: "Reading/writing individual CRM records by ID or specific criteria",
    notFor: "Broad topic searches across deals — use crm-search instead",
  },
  "dodi-ops": {
    description: "Production operations — jobs, cases, designs, cutlists, comments, attachments",
    usage: "Reading/writing operational records in the dodi platform",
  },
  clickup: {
    description: "Task management — tasks, lists, spaces, comments, custom fields",
    usage: "Creating and managing project tasks",
  },
  google: {
    description: "Email (Gmail), calendar, Google Drive files",
    usage: "Sending email, checking calendar events, reading Drive documents",
  },
  resend: {
    description: "Send outbound email with file attachments",
    usage: "Sending transactional or outreach email from your agent address",
    notFor: "Reading email — use google for inbox access",
  },
  "brave-search": {
    description: "Web search, news, local business lookup",
    usage: "Finding current information from the public web",
    notFor: "Internal data — use crm-search, code-search, or memory instead",
  },
  contacts: {
    description: "Contact lookups by name, email, or phone",
    usage: "Quick lookups of people in the contact directory",
    notFor: "CRM deal/company data — use hubspot-crm or crm-search instead",
  },
  permits: {
    description: "Permit pipeline data — active permits by jurisdiction, status, owner",
    usage: "Looking up building permits for lead generation or status checks",
  },
  linear: {
    description: "Issue tracking and project management",
    usage: "Creating, searching, and updating engineering issues",
  },
  catalog: {
    description: "Product catalog — parts, families, pricing",
    usage: "Looking up product specs, pricing, and part details",
  },
  "github-issues": {
    description: "GitHub issue tracking — create, search, update, comment on issues",
    usage: "Managing GitHub issues for engineering work",
  },
  quo: {
    description: "Send and receive SMS messages via OpenPhone",
    usage: "Texting customers or team members",
  },
  tasks: {
    description: "Task management — create, update, and track agent tasks",
    usage: "Managing your own task queue",
  },
  "code-search": {
    description: "Semantic search over codebase file index — find where functionality lives, file roles, exports",
    usage: "Finding code by what it does, not just by filename",
    notFor: "Broad web search — use brave-search instead",
  },
  "code-task": {
    description: "Spawn Claude Code CLI sessions for coding tasks",
    usage: "Delegating implementation, debugging, or code analysis work",
  },
  memory: {
    description: "Read and write your personal agent memory",
    usage: "Storing and retrieving facts across conversations. Auto-managed — don't over-save",
  },
  // structured-memory is auto-paired infrastructure (injected when memory is present) — not shown in prompt
  schedule: {
    description: "Self-service schedule management — view, add, update, remove your schedules",
    usage: "Managing your recurring or one-time scheduled tasks",
  },
  "event-bus": {
    description: "Publish events to the cross-agent event bus",
    usage: "Notifying other agents about state changes or completed work",
  },
  "product-search": {
    description: "Semantic search across product catalog — find products by description or attributes",
    usage: "Finding products when you don't know the exact part ID",
    notFor: "Looking up specific parts by ID — use catalog instead",
  },
  "ops-search": {
    description: "Semantic search across operational data — find jobs, cases, designs by description",
    usage: "Broad discovery across ops data by topic or keyword",
    notFor: "Reading/writing specific records — use dodi-ops for targeted operations",
  },
  "crm-search": {
    description: "Semantic search across CRM deals by topic or keyword",
    usage: "Broad discovery queries across deals and contacts",
    notFor: "Reading/writing specific records — use hubspot-crm for targeted CRUD",
  },
  callback: {
    description: "Schedule future self-invocations",
    usage: "Reminding yourself to follow up on something later",
  },
  background: {
    description: "Spawn detached background processes",
    usage: "Running long-lived commands that outlive your current turn",
  },
  "conversation-search": {
    description: "Semantic search over past conversations",
    usage: "Finding what was discussed previously across threads",
  },
  browser: {
    description: "Browser automation via Playwright — navigate, click, fill forms, screenshot",
    usage: "Accessing web UIs that don't have APIs",
  },
  slack: {
    description: "Slack API — read channels, post messages, manage threads",
    usage: "Interacting with Slack channels and threads",
  },
  recall: {
    description: "Meeting bot — join calls, get transcripts",
    usage: "Participating in or getting transcripts from video meetings",
  },
  admin: {
    description: "Agent management — list, view, update agent definitions",
    usage: "Viewing or modifying agent configurations",
  },
};
```

- [ ] **Step 3:** Add helper to format catalog entry for prompt

```typescript
/** Format a catalog entry as a prompt line: "- name: description\n  → usage / notFor" */
export function formatCatalogEntry(name: string, entry: ServerCatalogEntry): string {
  let line = `- ${name}: ${entry.description}`;
  const hints: string[] = [];
  if (entry.usage) hints.push(`Use for: ${entry.usage}.`);
  if (entry.notFor) hints.push(`Not for: ${entry.notFor}.`);
  if (hints.length > 0) {
    line += `\n  → ${hints.join(" ")}`;
  }
  return line;
}
```

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: no errors (new file, no consumers yet)

- [ ] **Step 5:** Commit

```bash
git add src/tools/server-catalog.ts
git commit -m "feat(tool-registry): add ServerCatalog type and core server entries (#87)"
```

---

### Task 2: Add usage/notFor to plugin manifest types and loader

**Files:**
- Modify: `src/plugins/types.ts`
- Modify: `src/plugins/plugin-loader.ts`

- [ ] **Step 1:** Add fields to `PluginMcpServer`

In `src/plugins/types.ts`, add after `description?` (line 3):

```typescript
  /** When to use this server — guidance for agents */
  usage?: string;
  /** Common misuse — "for X, use Y instead" */
  notFor?: string;
```

- [ ] **Step 2:** Parse new fields in `normalizeManifest()`

In `src/plugins/plugin-loader.ts`, in the `normalizeManifest()` function (line 53-71), update the mcpServers mapping to include the new fields:

```typescript
  // BEFORE (line 60-66):
  {
    entry: v.entry,
    description: v.description,
    env: v.env ?? [],
    envMap: v["env-map"] ?? {},
    agentEnv: v["agent-env"] ?? {},
  },

  // AFTER:
  {
    entry: v.entry,
    description: v.description,
    usage: v.usage,
    notFor: v["not-for"],
    env: v.env ?? [],
    envMap: v["env-map"] ?? {},
    agentEnv: v["agent-env"] ?? {},
  },
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4:** Commit

```bash
git add src/plugins/types.ts src/plugins/plugin-loader.ts
git commit -m "feat(tool-registry): add usage/notFor fields to plugin manifest types (#87)"
```

---

### Task 3: Enrich plugin.yaml with description fields

**Files:**
- Modify: `plugins/dodi/plugin.yaml`

All dodi plugin servers now have entries in `SERVER_CATALOG` (Task 1), so the catalog is the primary metadata source. However, plugin.yaml should carry `description` fields as a self-documenting fallback — these are used when a plugin server is NOT in the core catalog (e.g., a third-party plugin).

- [ ] **Step 1:** Add `description` fields to servers that lack them

Currently NO servers in `plugins/dodi/plugin.yaml` have `description` fields. Add them for self-documentation and as fallback metadata:

```yaml
mcp-servers:
  hubspot-crm:
    entry: mcp-servers/hubspot-crm/hubspot-crm-mcp-server.ts
    description: "Search and manage CRM — deals, contacts, companies, notes, tasks, activities"
    env: [HUBSPOT_API_KEY]
  dodi-ops:
    entry: mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
    description: "Production operations — jobs, cases, designs, cutlists, comments, attachments"
    env: [TASK_LEDGER_API_URL, TASK_LEDGER_API_KEY]
    env-map:
      DODI_OPS_API_URL: TASK_LEDGER_API_URL
      DODI_OPS_API_KEY: TASK_LEDGER_API_KEY
    agent-env:
      DODI_OPS_MODE: dodiOpsMode
      DODI_OPS_AGENT_ID: id
  catalog:
    entry: mcp-servers/catalog/catalog-mcp-server.ts
    description: "Product catalog — parts, families, pricing"
    env: [TASK_LEDGER_API_URL, TASK_LEDGER_API_KEY]
    env-map:
      CATALOG_API_URL: TASK_LEDGER_API_URL
      CATALOG_API_KEY: TASK_LEDGER_API_KEY
  permits:
    entry: mcp-servers/permits/permit-mcp-server.ts
    description: "Permit pipeline data — active permits by jurisdiction, status, owner"
    env: [PERMITS_MONGO_URI]
  crm-search:
    entry: mcp-servers/crm-search/crm-search-mcp-server.ts
    description: "Semantic search across CRM deals by topic or keyword"
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY, KB_BACKEND]
  product-search:
    entry: mcp-servers/product-search/product-search-mcp-server.ts
    description: "Semantic search across product catalog — find products by description or attributes"
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
  ops-search:
    entry: mcp-servers/ops-search/ops-search-mcp-server.ts
    description: "Semantic search across operational data — find jobs, cases, designs by description"
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
```

Note: preserve all existing fields (`env`, `env-map`, `agent-env`). Only add `description`. Do NOT add `usage`/`not-for` here — those live in `SERVER_CATALOG` for these servers. Plugin YAML `usage`/`not-for` is for third-party plugins whose servers aren't in the core catalog.

- [ ] **Step 2:** Verify YAML parses correctly

Run: `node -e "const {parse} = require('yaml'); const fs = require('fs'); const m = parse(fs.readFileSync('plugins/dodi/plugin.yaml','utf-8')); console.log(m['mcp-servers']['product-search'].description)"`
Expected: `Semantic search across product catalog — find products by description or attributes`

- [ ] **Step 3:** Commit

```bash
git add plugins/dodi/plugin.yaml
git commit -m "feat(tool-registry): add description fields to dodi plugin servers (#87)"
```

---

### Task 4: Update agent-runner — catalog integration and prompt builder

**Files:**
- Modify: `src/agents/agent-runner.ts`

This is the core wiring task. Three changes:
1. Switch import from `NAMESPACE_DESCRIPTIONS` to `SERVER_CATALOG`
2. Replace `getServerDescription()` with `getServerCatalogEntry()`
3. Update `buildSystemPrompt()` to show core servers and use richer formatting

- [ ] **Step 1:** Update import (line 10)

```typescript
// BEFORE:
import { NAMESPACE_DESCRIPTIONS } from "../delegate/namespace-descriptions.js";

// AFTER:
import { SERVER_CATALOG, formatCatalogEntry, type ServerCatalogEntry } from "../tools/server-catalog.js";
```

- [ ] **Step 2:** Replace `getServerDescription()` with `getServerCatalogEntry()`

Replace lines 676-693:

```typescript
  /**
   * Get catalog metadata for a server name.
   * Checks core server catalog first, then plugin manifests.
   */
  private getServerCatalogEntry(serverName: string): ServerCatalogEntry {
    // Check core server catalog
    if (SERVER_CATALOG[serverName]) {
      return SERVER_CATALOG[serverName];
    }
    // Check plugin manifests
    for (const plugin of this.plugins) {
      const serverDef = plugin.manifest.mcpServers[serverName];
      if (serverDef?.description) {
        return {
          description: serverDef.description,
          usage: serverDef.usage,
          notFor: serverDef.notFor,
        };
      }
    }
    return { description: serverName };
  }
```

- [ ] **Step 3:** Update `buildSystemPrompt()` — add core tools section and update delegates section

Update the `buildSystemPrompt` signature to accept core server names as well (line 64):

```typescript
// BEFORE:
private async buildSystemPrompt(activeDelegates?: string[]): Promise<string> {

// AFTER:
private async buildSystemPrompt(coreServerNames: string[], activeDelegates?: string[]): Promise<string> {
```

Replace the semi-static delegates section (lines 83-96):

```typescript
    // --- Semi-static (stable within a session, changes on restart) ---

    // Inject core server summaries so the agent knows what tools it has directly
    // Exclude infrastructure servers that are always present and self-explanatory
    const INFRASTRUCTURE_SERVERS = new Set([
      "schedule", "structured-memory",
    ]);
    const visibleCoreServers = coreServerNames.filter((s) => !INFRASTRUCTURE_SERVERS.has(s));
    if (visibleCoreServers.length > 0) {
      const lines = visibleCoreServers.map((s) => formatCatalogEntry(s, this.getServerCatalogEntry(s)));
      parts.push(
        `## Your tools\n\nDirect tools available to you:\n${lines.join("\n")}`,
      );
    }

    // Inject delegate namespace summaries so the agent knows what subagents are available
    // Uses activeDelegates (actually constructed) rather than config (may include credential-gated servers)
    const delegates = activeDelegates ?? [];
    if (delegates.length > 0) {
      const lines = delegates.map((s) => formatCatalogEntry(s, this.getServerCatalogEntry(s)));
      parts.push(
        `## Available via subagents\n\nUse the Agent tool to delegate tasks to these specialists:\n${lines.join("\n")}`,
      );
    }
```

- [ ] **Step 4:** Update `send()` to pass core server names to `buildSystemPrompt()`

In `send()` (line 769), update the call:

```typescript
// BEFORE:
const systemPrompt = await this.buildSystemPrompt(Object.keys(delegateAgents));

// AFTER:
const systemPrompt = await this.buildSystemPrompt(Object.keys(mcpServers), Object.keys(delegateAgents));
```

- [ ] **Step 5:** Update `buildDelegateAgents()` to use new method name

At line 648 in `buildDelegateAgents()`, the current code is:

```typescript
// BEFORE (line 648):
const description = this.getServerDescription(serverName);

// AFTER:
const description = this.getServerCatalogEntry(serverName).description;
```

**Critical:** `AgentDefinition.description` (SDK type) expects `string`, not `ServerCatalogEntry`. Extract `.description` here — the full catalog entry is only used for prompt formatting via `formatCatalogEntry()`.

- [ ] **Step 6:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 7:** Commit

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(tool-registry): integrate ServerCatalog into prompt builder (#87)"
```

---

### Task 5: Delete old namespace-descriptions.ts

**Files:**
- Delete: `src/delegate/namespace-descriptions.ts`

- [ ] **Step 1:** Verify no other imports

Run: `grep -rn "namespace-descriptions" src/`
Expected: only `agent-runner.ts` (already updated in Task 4). If others exist, update them.

- [ ] **Step 2:** Delete the file

```bash
git rm src/delegate/namespace-descriptions.ts
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 4:** Commit

```bash
git commit -m "refactor(tool-registry): remove deprecated namespace-descriptions (#87)"
```

---

### Task 6: Update tests

**Files:**
- Modify: `src/agents/agent-runner.test.ts`

- [ ] **Step 1:** Read the existing delegate subagent tests

Read lines 517-700 of `src/agents/agent-runner.test.ts` to understand the current test patterns for system prompt content and delegate injection.

- [ ] **Step 2:** Update existing tests

Find tests that reference:
- `"Available via subagents"` — these still pass, section name unchanged
- `NAMESPACE_DESCRIPTIONS` — update import if mock references exist
- `getServerDescription` — update if directly tested

- [ ] **Step 3:** Add test for core tools section in system prompt

Add a test that verifies core servers appear in the "Your tools" section:

```typescript
it("injects core server catalog into system prompt as 'Your tools'", async () => {
  // Agent with hubspot-crm as core server
  const runner = createRunner({
    coreServers: ["hubspot-crm", "memory"],
    delegateServers: [],
  });
  await runner.send("test");
  const options = getLastQueryOptions();
  expect(options.systemPrompt).toContain("## Your tools");
  expect(options.systemPrompt).toContain("hubspot-crm:");
  expect(options.systemPrompt).toContain("Use for:");
});
```

- [ ] **Step 4:** Add test for infrastructure server exclusion

```typescript
it("excludes infrastructure servers from 'Your tools' section", async () => {
  const runner = createRunner({
    coreServers: ["memory", "schedule"],
    delegateServers: [],
  });
  await runner.send("test");
  const options = getLastQueryOptions();
  // schedule is infrastructure — should not appear in "Your tools"
  // memory should appear
  expect(options.systemPrompt).toContain("memory:");
  expect(options.systemPrompt).not.toMatch(/- schedule:/);
});
```

- [ ] **Step 5:** Add test for plugin server usage/notFor

```typescript
it("includes plugin server usage and notFor in prompt", async () => {
  const runner = createRunner({
    coreServers: [],
    delegateServers: ["crm-search"],
    plugins: [mockPluginWithUsage],  // plugin manifest with usage + notFor fields
  });
  await runner.send("test");
  const options = getLastQueryOptions();
  expect(options.systemPrompt).toContain("Use for:");
  expect(options.systemPrompt).toContain("Not for:");
});
```

**Important:** The test snippets above use pseudo-helpers for clarity. The actual test file uses `new AgentRunner(makeAgentConfig({...}), memoryManager as any)` and `getCapturedOptions()`. Read the file in Step 1 and adapt all new tests to match the real patterns.

- [ ] **Step 6:** Verify

Run: `npx vitest run src/agents/agent-runner.test.ts`
Expected: all tests pass

- [ ] **Step 7:** Commit

```bash
git add src/agents/agent-runner.test.ts
git commit -m "test(tool-registry): update agent-runner tests for ServerCatalog (#87)"
```

---

### Task 7: Final verification

- [ ] **Step 1:** Full type check

Run: `npx tsc --noEmit`
Expected: no errors

- [ ] **Step 2:** Full test suite

Run: `npx vitest run`
Expected: all tests pass

- [ ] **Step 3:** Build

Run: `npm run build`
Expected: clean build

- [ ] **Step 4:** Verify no stale references

Run: `grep -rn "NAMESPACE_DESCRIPTIONS\|namespace-descriptions" src/ plugins/`
Expected: zero results (all replaced)
