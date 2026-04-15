# Issue #135 — Core Decontamination Implementation Plan

> **For agentic workers:** Use `dodi-dev:implement` to execute this plan.

**Goal:** Remove every dodi/hubspot/cabinet string from `pkg/*.min.js` so the `@keepur/hive` tarball is customer-clean, while keeping the in-tree dodi plugin (and the dodi-hive deploy that depends on it) functional.

**Architecture:** Apply `docs/specs/2026-04-14-plugin-architecture-design.md` §6.4 to the current codebase. Three structural changes carry the work: (a) a dotted-path `agent-env` resolver lets plugins read agent fields they used to need typed core support for; (b) `metadata: Record<string, unknown>` replaces the typed `dodiOpsMode` field bag; (c) `instance-capabilities.ts` and `server-catalog.ts` shed every plugin-specific entry and let plugin manifests carry the metadata. Everything else (config block deletes, comment sanitization, default id rename, CI guardrail) is mechanical follow-on.

**Tech Stack:** TypeScript (strict), Vitest, Node 24, esbuild bundle pipeline (`build/bundle.ts`).

**Spec sections to read first:** §5.3 (resolver semantics), §6.4 (mechanical change list), §11 (step list and explicit non-scope), §7.4 (`hiveApi` / `HIVE_PLUGIN_API_VERSION`).

**Out of scope (per spec §11):** physical extraction of `plugins/dodi/`, the `hive_composition` MongoDB collection, removing `agent-seeds` from `plugin.yaml`, demoting Resend to a plugin, demoting Linear to a plugin, the Honeypot/Vault credential channel.

---

## File Map

**Create:**
- `src/plugins/api-version.ts` — exports `HIVE_PLUGIN_API_VERSION`
- `scripts/check-bundle-strings.mjs` — CI guardrail that fails if `pkg/*.min.js` contains forbidden plugin-specific strings

**Modify (core decontamination):**
- `src/types/agent-definition.ts` — drop `dodiOpsMode`, add `metadata`
- `src/types/agent-config.ts` — drop `dodiOpsMode`, add `metadata`
- `src/agents/agent-runner.ts` — dotted-path `agent-env` resolver; rename `HUBSPOT_BCC` env key passed to resend server
- `src/agents/agent-runner.test.ts` — update `agentEnv` test to exercise dotted path
- `src/agents/agent-registry.test.ts` — update fixture to use `metadata.dodiOpsMode`
- `src/admin/admin-mcp-server.ts` — drop `Dodi Ops Mode` user-visible line
- `src/admin/admin-api.ts` — drop `dodiOpsMode` field on agent create
- `src/config.ts` — delete `hubspot` block; rename `resend.hubspotBcc` → `resend.defaultBcc`
- `src/resend/resend-mcp-server.ts` — read `RESEND_DEFAULT_BCC` instead of `HUBSPOT_BCC`; rename internal constant
- `src/tools/server-catalog.ts` — delete plugin-specific entries
- `src/tools/instance-capabilities.ts` — delete plugin-specific credential checks; remove `integrations` block from interface and builder
- `src/tools/instance-capabilities.test.ts` — drop assertions on deleted entries and on `integrations`
- `src/tasks/task-ledger.ts` — sanitize `dodi_v2` doc comment
- `src/tasks/task-mcp-server.ts` — sanitize `dodi_v2` doc comment
- `src/sweeper/sweeper.ts` — sanitize `dodi_v2` comments and `reportToDodi` method name
- `src/code-index/code-search-mcp-server.ts` — change `repo` enum to free-form string
- `src/code-task/knowledge-extractor.ts` — sanitize prompt template
- `src/plugins/plugin-loader.ts` — read `hiveApi` from manifest, log+skip on incompatibility
- `src/plugins/types.ts` — add `hiveApi` to `PluginManifest`
- `setup/setup-instance.ts:104` — default id `"dodi"` → `"hive"`
- `setup/setup-seeds.ts` — pass through `metadata` instead of `dodiOpsMode`
- `setup/migrate-agents.ts` — pass through `metadata` instead of `dodiOpsMode`

**Modify (plugin side, same PR — keeps dodi-hive working):**
- `plugins/dodi/plugin.yaml` — add `hiveApi`, `usage`/`not-for` per server, switch `agent-env` to dotted path
- `plugins/dodi/agent-seeds/customer-success.yaml` — `dodiOpsMode: full` → `metadata: { dodiOpsMode: full }`
- `plugins/dodi/agent-seeds/production-support.yaml` — `dodiOpsMode: readonly` → `metadata: { dodiOpsMode: readonly }`

**Modify (CI):**
- `.github/workflows/check.yml` (or wherever `npm run check` is wired) — add `npm run bundle && node scripts/check-bundle-strings.mjs` step

---

## Atomicity rules (read before starting)

- **Tasks 2, 3, 4, and 5 must land in a single commit.** They form one logical change: the dotted-path resolver (Task 2), the `dodiOpsMode` → `metadata` type change (Task 3), the plugin manifest update to reference `metadata.dodiOpsMode` (Task 4), and the dodi seeds switching to the `metadata` block (Task 5). Any subset breaks the dodi-hive deploy: removing `dodiOpsMode` from `AgentConfig` without the dotted-path resolver makes `DODI_OPS_MODE: dodiOpsMode` silently resolve to `""`; updating the manifest without the resolver lookup change makes the same env value `""`; updating the seeds without the type change is a YAML/Mongo schema mismatch. Spec §5.3 / §11 step 5.
- **Task 6 (server-catalog deletes) and Task 7 (instance-capabilities refactor) ship in a single commit.** After Task 6 removes the plugin entries from `SERVER_CATALOG` but Task 7 has not yet removed them from `SERVER_CREDENTIAL_CHECKS`, the existing `"SERVER_CREDENTIAL_CHECKS invariant"` test in `instance-capabilities.test.ts` enforces consistency between the two maps and will fail. The cleanest fix is to land both as one commit (matching the commit-group table at the bottom of this plan).

The full sequence still ships as a single PR (#135). Within that PR, commit boundaries can be granular, but the atomicity groups above must be preserved per-commit.

---

## Tasks

### Task 1: Hive plugin API version + manifest compatibility check

Adds the `hiveApi` infrastructure called for in spec §7.4 so the work in Task 2 has a "this is the 1.0.0 contract" anchor. Standalone — does not change runtime behavior for existing manifests until they declare `hiveApi`.

**Files:**
- Create: `src/plugins/api-version.ts`
- Modify: `src/plugins/types.ts`
- Modify: `src/plugins/plugin-loader.ts`

- [ ] **Step 1:** Create the version constant.

```typescript
// src/plugins/api-version.ts
/**
 * Hive plugin API version. Plugins declare a compatibility range in their
 * plugin.yaml under `hiveApi:` (e.g. "^1.0.0"). The loader skips plugins
 * whose declared range does not include this version. Bump the major when a
 * change to the plugin contract (manifest schema, agent-env resolver, base
 * env var set) breaks existing plugins.
 */
export const HIVE_PLUGIN_API_VERSION = "1.0.0";
```

- [ ] **Step 2:** Add `hiveApi` to the manifest type.

```typescript
// src/plugins/types.ts — add field to PluginManifest
export interface PluginManifest {
  name: string;
  description?: string;
  /** Semver range the plugin requires. Optional during transition; missing == accept-any. */
  hiveApi?: string;
  mcpServers: Record<string, PluginMcpServer>;
  agentSeeds: string[];
  registerCommands?: string;
}
```

- [ ] **Step 3:** Update `normalizeManifest` and add the compat check in `loadPlugins`.

In `src/plugins/plugin-loader.ts`, add `hiveApi` to the `normalizeManifest` return object:

```typescript
export function normalizeManifest(raw: any): PluginManifest {
  return {
    name: raw.name ?? "",
    description: raw.description ?? "",
    hiveApi: raw.hiveApi ?? raw["hive-api"] ?? undefined,
    mcpServers: Object.fromEntries(
      // ... unchanged
```

Then in `loadPlugins`, after `const manifest = normalizeManifest(raw);`, add:

```typescript
if (manifest.hiveApi) {
  const compatible = isHiveApiCompatible(manifest.hiveApi, HIVE_PLUGIN_API_VERSION);
  if (!compatible) {
    log.warn("Plugin declares incompatible hiveApi range, skipping", {
      plugin: name,
      requires: manifest.hiveApi,
      running: HIVE_PLUGIN_API_VERSION,
    });
    continue;
  }
}
```

Add imports at the top:

```typescript
import { HIVE_PLUGIN_API_VERSION } from "./api-version.js";
```

And add a minimal `isHiveApiCompatible` helper at module scope (do **not** add a `semver` dependency for this — keep it tiny):

```typescript
/**
 * Minimal semver range check. Supports caret ranges ("^1.0.0") and exact
 * versions ("1.0.0"). Anything else is treated as accept-any with a warn.
 */
function isHiveApiCompatible(range: string, version: string): boolean {
  const trimmed = range.trim();
  if (trimmed === version) return true;
  if (trimmed.startsWith("^")) {
    const want = trimmed.slice(1).split(".").map(Number);
    const have = version.split(".").map(Number);
    if (want.length < 1 || have.length < 1) return false;
    if (want[0] !== have[0]) return false;
    if ((have[1] ?? 0) < (want[1] ?? 0)) return false;
    if ((have[1] ?? 0) === (want[1] ?? 0) && (have[2] ?? 0) < (want[2] ?? 0)) return false;
    return true;
  }
  log.warn("Unrecognized hiveApi range syntax, accepting", { range });
  return true;
}
```

- [ ] **Step 4:** Verify.

Run: `npm run typecheck && npm run test -- src/plugins`
Expected: green; no plugin currently declares `hiveApi`, so behavior is unchanged.

- [ ] **Step 5:** Commit.

```bash
git add src/plugins/api-version.ts src/plugins/types.ts src/plugins/plugin-loader.ts
git commit -m "feat(plugins): add hiveApi compatibility constant and loader check"
```

---

### Task 2: Dotted-path `agent-env` resolver (atomic with Task 3)

Implements §5.3 resolver semantics. **Do not commit alone** — combine with Task 3 in a single commit. Listed as a separate task only for clarity.

**Files:**
- Modify: `src/agents/agent-runner.ts:638-640`
- Modify: `src/agents/agent-runner.test.ts:341-370`

- [ ] **Step 1:** Replace the resolver loop in `agent-runner.ts`.

Current code (around line 638):

```typescript
for (const [envVar, fieldName] of Object.entries(serverDef.agentEnv ?? {})) {
  env[envVar] = String((this.agentConfig as any)[fieldName] ?? "");
}
```

Replace with:

```typescript
for (const [envVar, fieldPath] of Object.entries(serverDef.agentEnv ?? {})) {
  env[envVar] = resolveAgentEnvPath(this.agentConfig, fieldPath);
}
```

Add the helper as a private static method on `AgentRunner` (or a module-scope function — pick the convention that matches the rest of the file; static method is consistent with existing code):

```typescript
/**
 * Resolve an agent-env path against the agent config. Supports dotted paths
 * for nested objects (e.g. "metadata.dodiOpsMode"). Walks left-to-right; any
 * missing intermediate key yields "". No fallback to top-level fields — a
 * misconfigured key surfaces as an empty value, which the plugin must
 * handle defensively (per spec §5.3 resolver semantics).
 *
 * Flat (non-dotted) keys still resolve against top-level fields, preserving
 * backward compatibility with manifests that have not migrated.
 */
private static resolveAgentEnvPath(config: AgentConfig, path: string): string {
  const parts = path.split(".");
  let current: unknown = config;
  for (const part of parts) {
    if (current == null || typeof current !== "object") return "";
    current = (current as Record<string, unknown>)[part];
  }
  return current == null ? "" : String(current);
}
```

(Call site adjusts to `AgentRunner.resolveAgentEnvPath(this.agentConfig, fieldPath)`.)

Type-side: import `AgentConfig` if not already imported in this file.

- [ ] **Step 2:** Update the existing test to exercise both flat and dotted paths.

Replace the body of the `"resolves plugin agentEnv from agent config fields"` test in `src/agents/agent-runner.test.ts` (current location ~line 341):

```typescript
it("resolves plugin agentEnv from agent config fields", async () => {
  const plugin: LoadedPlugin = {
    name: "test-plugin",
    dir: "/plugins/test-plugin",
    manifest: {
      name: "test-plugin",
      description: "Test",
      mcpServers: {
        "agent-env-server": {
          entry: "mcp-servers/ae/index.ts",
          env: [],
          envMap: {},
          agentEnv: {
            CUSTOM_ID: "id",                      // flat
            CUSTOM_MODE: "metadata.dodiOpsMode",  // dotted
            CUSTOM_MISSING: "metadata.notThere",  // dotted miss
          },
        },
      },
      agentSeeds: [],
    },
  };

  runner = new AgentRunner(
    makeAgentConfig({
      metadata: { dodiOpsMode: "readonly" },
      coreServers: ["agent-env-server"],
    }),
    memoryManager as any,
    [plugin],
  );
  await runner.send("hello");
  const servers = getCapturedServers();

  expect(servers["agent-env-server"].env.CUSTOM_ID).toBe("test-agent");
  expect(servers["agent-env-server"].env.CUSTOM_MODE).toBe("readonly");
  expect(servers["agent-env-server"].env.CUSTOM_MISSING).toBe("");
});
```

Note: this test depends on `makeAgentConfig` accepting `metadata` — which Task 3 adds to `AgentConfig`. That's why these tasks must commit together.

- [ ] **Step 3:** Defer verification to Task 3.

Do not run tests yet — `metadata` is not on `AgentConfig` until Task 3 lands. Continue to Task 3.

---

### Task 3: Replace `dodiOpsMode` with `metadata` field bag (atomic with Tasks 2, 4, 5)

Spec §5.3. Removes the last typed plugin-specific leak from core types.

**Files:**
- Modify: `src/types/agent-definition.ts`
- Modify: `src/types/agent-config.ts`
- Modify: `src/admin/admin-mcp-server.ts:114, 191`
- Modify: `src/admin/admin-api.ts:178`
- Modify: `src/agents/agent-registry.test.ts:104, 110`
- Modify: `setup/setup-seeds.ts:68`
- Modify: `setup/migrate-agents.ts:116`

- [ ] **Step 1:** Update `AgentDefinition`.

In `src/types/agent-definition.ts`, replace:

```typescript
  plugins?: string[];
  dodiOpsMode?: "full" | "readonly";
```

with:

```typescript
  plugins?: string[];
  /**
   * Plugin-managed per-agent settings. Core never reads this field — plugins
   * pull values via `agent-env` manifest mappings (e.g. `metadata.dodiOpsMode`).
   * Free-form to avoid coupling core to plugin schemas.
   */
  metadata?: Record<string, unknown>;
```

Then in `toAgentConfig` (line ~103), replace `dodiOpsMode: doc.dodiOpsMode,` with `metadata: doc.metadata,`.

- [ ] **Step 2:** Update `AgentConfig`.

In `src/types/agent-config.ts`, replace:

```typescript
  dodiOpsMode?: "full" | "readonly"; // Dodi Ops access level. Default: "full"
```

with:

```typescript
  metadata?: Record<string, unknown>; // plugin-managed bag — read via agent-env dotted paths
```

- [ ] **Step 3:** Drop `dodiOpsMode` from admin tools and API.

`src/admin/admin-mcp-server.ts`:

- Line ~114: delete the `if (doc.dodiOpsMode) lines.push(...)` line entirely. Beekeepers can read `metadata` via the raw definition output if they need it.
- Line ~191: replace `dodiOpsMode: f.dodiOpsMode as "full" | "readonly" | undefined,` with `metadata: f.metadata as Record<string, unknown> | undefined,`. The agent_create input schema uses `fields: z.record(z.string(), z.any())` which already accepts arbitrary keys — no Zod schema change needed.

`src/admin/admin-api.ts:178`: replace `dodiOpsMode: body.dodiOpsMode,` with `metadata: body.metadata,`.

- [ ] **Step 4:** Update tests that constructed agents with `dodiOpsMode`.

`src/agents/agent-registry.test.ts:104-110`: replace the `dodiOpsMode: "readonly"` field with `metadata: { dodiOpsMode: "readonly" }`, and the `expect(config.dodiOpsMode).toBe("readonly")` assertion with `expect((config.metadata as { dodiOpsMode: string }).dodiOpsMode).toBe("readonly")`.

The `agent-runner.test.ts` test was already updated in Task 2.

- [ ] **Step 5:** Update setup helpers.

`setup/setup-seeds.ts:68`: replace `dodiOpsMode: raw.dodiOpsMode,` with `metadata: raw.metadata,`.

`setup/migrate-agents.ts:116`: replace `dodiOpsMode: (raw.dodiOpsMode as "full" | "readonly") || undefined,` with `metadata: (raw.metadata as Record<string, unknown>) || undefined,`.

- [ ] **Step 6:** Defer verification to Task 5 (the dodi seeds and plugin.yaml still need updating before tests will pass).

---

### Task 4: Update `plugins/dodi/plugin.yaml` (atomic with Task 3)

**Files:**
- Modify: `plugins/dodi/plugin.yaml`

- [ ] **Step 1:** Add `hiveApi`, `usage`/`not-for`, switch dotted path.

Replace the entire file:

```yaml
name: dodi
description: DodiHome cabinet manufacturing integrations
hiveApi: "^1.0.0"
mcp-servers:
  hubspot-crm:
    entry: mcp-servers/hubspot-crm/hubspot-crm-mcp-server.ts
    description: "Search and manage CRM — deals, contacts, companies, notes, tasks, activities"
    usage: "Reading/writing individual CRM records by ID or specific criteria"
    not-for: "Broad topic searches across deals — use crm-search instead"
    env: [HUBSPOT_API_KEY]
  dodi-ops:
    entry: mcp-servers/dodi-ops/dodi-ops-mcp-server.ts
    description: "Production operations — jobs, cases, designs, cutlists, comments, attachments"
    usage: "Reading/writing operational records in the dodi platform"
    env: [TASK_LEDGER_API_URL, TASK_LEDGER_API_KEY]
    env-map:
      DODI_OPS_API_URL: TASK_LEDGER_API_URL
      DODI_OPS_API_KEY: TASK_LEDGER_API_KEY
    agent-env:
      DODI_OPS_MODE: metadata.dodiOpsMode
      DODI_OPS_AGENT_ID: id
  catalog:
    entry: mcp-servers/catalog/catalog-mcp-server.ts
    description: "Product catalog — parts, families, pricing"
    usage: "Looking up product specs, pricing, and part details"
    not-for: "Broad product discovery — use product-search instead"
    env: [TASK_LEDGER_API_URL, TASK_LEDGER_API_KEY]
    env-map:
      CATALOG_API_URL: TASK_LEDGER_API_URL
      CATALOG_API_KEY: TASK_LEDGER_API_KEY
  permits:
    entry: mcp-servers/permits/permit-mcp-server.ts
    description: "Permit pipeline data — active permits by jurisdiction, status, owner"
    usage: "Looking up building permits for lead generation or status checks"
    env: [PERMITS_MONGO_URI]
  crm-search:
    entry: mcp-servers/crm-search/crm-search-mcp-server.ts
    description: "Semantic search across CRM deals by topic or keyword"
    usage: "Broad discovery queries across deals and contacts"
    not-for: "Reading/writing specific records — use hubspot-crm for targeted CRUD"
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY, KB_BACKEND]
  product-search:
    entry: mcp-servers/product-search/product-search-mcp-server.ts
    description: "Semantic search across product catalog — find products by description or attributes"
    usage: "Finding products when you don't know the exact part ID"
    not-for: "Looking up specific parts by ID — use catalog instead"
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
  ops-search:
    entry: mcp-servers/ops-search/ops-search-mcp-server.ts
    description: "Semantic search across operational data — find jobs, cases, designs by description"
    usage: "Broad discovery across ops data by topic or keyword"
    not-for: "Reading/writing specific records — use dodi-ops for targeted operations"
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
agent-seeds:
  - sdr
  - customer-success
  - marketing-manager
  - executive-assistant
  - product-manager
  - product-specialist
  - vp-engineering
  - devops
  - production-support
```

The `agent-seeds` block stays per spec §11 explicit non-scope — removing it is reserved for the physical-extraction follow-on.

---

### Task 5: Update dodi agent seeds to use `metadata`

**Files:**
- Modify: `plugins/dodi/agent-seeds/customer-success.yaml:22`
- Modify: `plugins/dodi/agent-seeds/production-support.yaml:24`

- [ ] **Step 1:** `customer-success.yaml` — replace line `dodiOpsMode: full` with:

```yaml
metadata:
  dodiOpsMode: full
```

- [ ] **Step 2:** `production-support.yaml` — replace line `dodiOpsMode: readonly` with:

```yaml
metadata:
  dodiOpsMode: readonly
```

- [ ] **Step 3:** Verify Tasks 2–5 together.

Run: `npm run typecheck && npm run test`
Expected: green. The compiler enforces that no other site references `dodiOpsMode` on `AgentDefinition`/`AgentConfig`. If a missed reference surfaces, fix it inline (the grep in the appendix lists all known sites — anything outside that list is a real find).

- [ ] **Step 4:** Commit Tasks 2–5 atomically.

```bash
git add src/agents/agent-runner.ts src/agents/agent-runner.test.ts \
  src/agents/agent-registry.test.ts \
  src/types/agent-definition.ts src/types/agent-config.ts \
  src/admin/admin-mcp-server.ts src/admin/admin-api.ts \
  setup/setup-seeds.ts setup/migrate-agents.ts \
  plugins/dodi/plugin.yaml \
  plugins/dodi/agent-seeds/customer-success.yaml \
  plugins/dodi/agent-seeds/production-support.yaml
git commit -m "refactor(plugins): replace dodiOpsMode with metadata bag, add dotted-path agent-env resolver"
```

---

### Task 6: Delete plugin-specific entries from `SERVER_CATALOG`

Spec §6.4 row "SERVER_CATALOG entries". Plugin-manifest fallback at `agent-runner.ts:866-883` already renders the same prompt text from `plugin.yaml`.

**Files:**
- Modify: `src/tools/server-catalog.ts`
- Modify: `src/tools/server-catalog.test.ts`

- [ ] **Step 1:** Delete the following keys from `SERVER_CATALOG`: `hubspot-crm`, `dodi-ops`, `permits`, `catalog`, `crm-search`, `product-search`, `ops-search`. Also delete the `notFor` reference to `dodi-ops` from `contacts` and from any other surviving entry — verify by re-grepping after the edit (see verification step).

Replace `notFor: "Reading/writing specific records — use dodi-ops for targeted operations"` on the `ops-search` entry with the entry being deleted entirely (no replacement needed).

The `contacts` entry currently references `hubspot-crm` in its `notFor`. Replace that line:

```typescript
contacts: {
  description: "Contact lookups by name, email, or phone",
  usage: "Quick lookups of people in the contact directory",
  notFor: "CRM deal/company data — use a CRM plugin's tools instead",
},
```

- [ ] **Step 2:** Update `src/tools/server-catalog.test.ts`.

The `"contains entries for all commonly used servers"` test has a hardcoded `expected` array referencing `"hubspot-crm"`, `"catalog"`, and `"crm-search"` — all three are deleted in Step 1 above and the test will fail. Replace the array with the surviving core servers:

```typescript
    const expected = [
      "google",
      "memory",
      "contacts",
      "slack",
      "brave-search",
      "resend",
      "keychain",
    ];
```

- [ ] **Step 3:** Defer full verification to Task 7 (the credential-check invariant test in `instance-capabilities.test.ts` still references the deleted catalog keys via its own hardcoded array; standalone the suite will fail there).

---

### Task 7: Refactor `instance-capabilities.ts` (atomic with Task 6)

Spec §6.4 rows "SERVER_CREDENTIAL_CHECKS" and "integrations block". Drops plugin-specific knowledge and removes the typed `integrations` map entirely (the spec is explicit: do not rebuild it).

**Files:**
- Modify: `src/tools/instance-capabilities.ts`
- Modify: `src/tools/instance-capabilities.test.ts`

- [ ] **Step 1:** Drop `integrations` from the interface.

```typescript
export interface InstanceCapabilities {
  instanceId: string;
  servers: {
    configured: string[];
    unconfigured: string[];
  };
}
```

- [ ] **Step 2:** Drop plugin-specific entries from `SERVER_CREDENTIAL_CHECKS`. Delete: `"hubspot-crm"`, `permits`, `catalog`, `"dodi-ops"`, `"product-search"`, `"ops-search"`. The `tasks` entry stays — task ledger is core. Final shape:

```typescript
const SERVER_CREDENTIAL_CHECKS: Record<string, () => boolean> = {
  google: () => Object.keys(config.google?.accounts ?? {}).length > 0 || !!config.google?.account,
  resend: () => !!config.resend?.apiKey,
  "brave-search": () => !!config.brave?.apiKey,
  linear: () => !!config.linear?.apiKey,
  clickup: () => !!config.clickup?.apiToken,
  "github-issues": () => !!config.github?.repo,
  quo: () => !!config.quo?.apiKey,
  recall: () => !!config.recall?.apiKey,
  "code-task": () => true,
  "code-search": () => !!config.codeIndex?.enabled,
  browser: () => !!config.browser?.cdpEndpoint,
  tasks: () => (config.taskLedger?.apiUrl ?? "") !== "http://localhost:3002",
};
```

- [ ] **Step 3:** Add a generic plugin-server credential check inside `buildInstanceCapabilities`.

The current loop iterates `Object.keys(SERVER_CATALOG)`. After the catalog deletions in Task 6, plugin servers no longer appear in the catalog — they need to be classified separately.

Add an optional `plugins` parameter to `buildInstanceCapabilities`:

```typescript
import type { LoadedPlugin } from "../plugins/types.js";

export function buildInstanceCapabilities(plugins: LoadedPlugin[] = []): InstanceCapabilities {
  const configured: string[] = [];
  const unconfigured: string[] = [];

  for (const serverName of Object.keys(SERVER_CATALOG)) {
    if (INFRASTRUCTURE_SERVERS.has(serverName)) {
      configured.push(serverName);
      continue;
    }
    const check = SERVER_CREDENTIAL_CHECKS[serverName];
    if (!check || check()) {
      configured.push(serverName);
    } else {
      unconfigured.push(serverName);
    }
  }

  // Plugin servers — generic check: configured iff every declared env var is non-empty
  for (const plugin of plugins) {
    for (const [serverName, serverDef] of Object.entries(plugin.manifest.mcpServers)) {
      const requiredEnv = serverDef.env ?? [];
      const hasAll = requiredEnv.length === 0
        || requiredEnv.every((envVar) => !!process.env[envVar]);
      if (hasAll) {
        configured.push(serverName);
      } else {
        unconfigured.push(serverName);
      }
    }
  }

  return {
    instanceId: config.instance?.id ?? "unknown",
    servers: { configured, unconfigured },
  };
}
```

- [ ] **Step 4:** Plumb plugins through the cache singleton in `src/agents/agent-runner.ts:22-29`.

The current call site is a module-scope lazy singleton with no access to plugins:

```typescript
let _cachedCapabilities: string | undefined;
function getCachedCapabilities(): string {
  if (!_cachedCapabilities) {
    _cachedCapabilities = JSON.stringify(buildInstanceCapabilities());
  }
  return _cachedCapabilities;
}
```

Replace with a singleton that accepts plugins on first call (all `AgentRunner` instances see the same plugins because they're loaded once at boot in `agent-manager.ts:loadPlugins(appConfig.plugins, ...)`, so caching off the first call is safe):

```typescript
let _cachedCapabilities: string | undefined;
function getCachedCapabilities(plugins: LoadedPlugin[]): string {
  if (!_cachedCapabilities) {
    _cachedCapabilities = JSON.stringify(buildInstanceCapabilities(plugins));
  }
  return _cachedCapabilities;
}
```

Then update the only call site of `getCachedCapabilities()` in this file (search the file for `getCachedCapabilities()` — it's in the admin server spawn block around line 718) to pass `this.plugins`:

```typescript
        INSTANCE_CAPABILITIES: getCachedCapabilities(this.plugins),
```

The `LoadedPlugin` type is already imported at line 13.

- [ ] **Step 5:** Update `instance-capabilities.test.ts`.

Delete the entire `it("builds integration summary correctly", ...)` and `it("reports issue-tracking with detail when both Linear and GitHub are configured", ...)` tests — the `integrations` block no longer exists.

In the `"classifies servers with valid credentials as configured"` test, delete the `expect(result.servers.configured).toContain("hubspot-crm");` line.

In the `"marks servers with default URIs as unconfigured"` test, delete the lines for `permits`, `catalog`, `dodi-ops`, `ops-search` — those servers are no longer in the catalog. Keep `tasks`.

Update the mock `vi.mock("../config.js", ...)`: delete the `hubspot: { apiKey: "hub_test" },` and `permits: { mongoUri: ... },` keys (they're being deleted from `config.ts` in Task 8 — leaving them in the mock would be confusing).

In the `"SERVER_CREDENTIAL_CHECKS invariant"` test, update the `credentialCheckServers` array to match the new `SERVER_CREDENTIAL_CHECKS` keys exactly. Delete: `"hubspot-crm"`, `"permits"`, `"catalog"`, `"dodi-ops"`, `"product-search"`, `"ops-search"`.

- [ ] **Step 6:** Verify.

Run: `npm run typecheck && npm run test -- src/tools`
Expected: green.

- [ ] **Step 7:** Commit.

```bash
git add src/tools/server-catalog.ts src/tools/server-catalog.test.ts \
  src/tools/instance-capabilities.ts src/tools/instance-capabilities.test.ts \
  src/agents/agent-runner.ts
git commit -m "refactor(tools): drop plugin-specific catalog and credential entries"
```

---

### Task 8: Delete `config.hubspot` block; rename resend BCC end-to-end

Spec §6.4 rows. Three sites must change together (config field, env var read in resend server, env key passed at server-spawn site in agent-runner).

**Files:**
- Modify: `src/config.ts:149, 154-156`
- Modify: `src/agents/agent-runner.ts:425`
- Modify: `src/resend/resend-mcp-server.ts:13, 25, 88, 148`

- [ ] **Step 1:** `src/config.ts` — delete the entire `hubspot` block:

```typescript
  hubspot: {
    apiKey: optional("HUBSPOT_API_KEY", ""),
  },
```

(Plugin MCP servers read `process.env.HUBSPOT_API_KEY` directly — they do not need it on `config`.)

- [ ] **Step 2:** `src/config.ts:149` — rename the resend BCC field. Replace:

```typescript
    hubspotBcc: optional("HUBSPOT_BCC_OUTGOING", ""),
```

with:

```typescript
    defaultBcc: optional("RESEND_DEFAULT_BCC", optional("HUBSPOT_BCC_OUTGOING", "")),
```

The nested `optional` keeps `HUBSPOT_BCC_OUTGOING` as a fallback so the dodi-hive deploy `.env` continues to work without an immediate file edit — drop the fallback in a follow-on once the deploy `.env` migrates.

- [ ] **Step 3:** `src/agents/agent-runner.ts:425` — replace:

```typescript
          HUBSPOT_BCC: config.resend.hubspotBcc,
```

with:

```typescript
          RESEND_DEFAULT_BCC: config.resend.defaultBcc,
```

- [ ] **Step 4:** `src/resend/resend-mcp-server.ts` — read the new env var. There are exactly four sites; address each explicitly.

(a) Line 13 (doc comment): replace `*   HUBSPOT_BCC         — HubSpot BCC address for outgoing email logging` with `*   RESEND_DEFAULT_BCC  — default BCC address applied to outgoing email`.

(b) Line 25: replace:

```typescript
const HUBSPOT_BCC = process.env.HUBSPOT_BCC ?? "";
```

with:

```typescript
const DEFAULT_BCC = process.env.RESEND_DEFAULT_BCC ?? "";
```

(c) Line 88 (symbol rename only — no string literal here): the line currently reads `if (HUBSPOT_BCC) bccList.push(HUBSPOT_BCC);` — rename both identifier occurrences to `DEFAULT_BCC`.

(d) Line ~148 (symbol rename **and** user-visible string literal): the line currently reads `...(HUBSPOT_BCC ? [\`  HubSpot: logged via BCC\`] : []),`. Rename the identifier `HUBSPOT_BCC` → `DEFAULT_BCC` **and** replace the literal string `'  HubSpot: logged via BCC'` with `'  Default BCC applied'`. Both changes on the same line.

Verify with: `Grep pattern "HUBSPOT" path src/resend/` — expected zero matches.

- [ ] **Step 5:** Verify.

Run: `npm run typecheck && npm run test`
Expected: green.

- [ ] **Step 6:** Commit.

```bash
git add src/config.ts src/agents/agent-runner.ts src/resend/resend-mcp-server.ts
git commit -m "refactor(config): drop hubspot block, rename resend BCC end-to-end"
```

---

### Task 9: Sanitize remaining string leaks

Every string in `src/` that contains `dodi` or `hubspot` or `cabinet` and gets bundled into `pkg/*.min.js`. These are the residual contamination Task 6 and 7 do not cover. The CI guardrail in Task 11 will fail if any remain.

**Files:**
- Modify: `src/tasks/task-ledger.ts:9`
- Modify: `src/tasks/task-mcp-server.ts:6`
- Modify: `src/sweeper/sweeper.ts:277, 285, 321`
- Modify: `src/code-index/code-search-mcp-server.ts:39`
- Modify: `src/code-task/knowledge-extractor.ts:46`
- Modify: `src/code-task/code-task-mcp-server.ts:80`
- Modify: `src/contacts/contacts-mcp-server.ts:35, 300`
- Modify: `src/linear/linear-mcp-server.ts:89`
- Modify: `src/github/github-issues-mcp-server.ts:8` (cosmetic — comment, but tidy while here)

- [ ] **Step 1:** `src/tasks/task-ledger.ts:9` — replace doc comment:

```typescript
 * Auto-tracks invisible agent work (scheduled jobs, background tasks, meetings, email)
 * as tasks in the configured task ledger backend. Fire-and-forget — never blocks the message pipeline.
```

- [ ] **Step 2:** `src/tasks/task-mcp-server.ts:6` — replace doc comment:

```typescript
 * Gives agents the ability to create, read, update, query, and comment on tasks
 * in the configured task ledger backend.
```

- [ ] **Step 3:** `src/sweeper/sweeper.ts` — sanitize comments and rename method.

Line 277 comment: `// Report to dodi_v2` → `// Report to task ledger backend`.

Line 285 method name: `private async reportToDodi(` → `private async reportToTaskLedger(`. Update the call site at line 279 from `await this.reportToDodi(...)` to `await this.reportToTaskLedger(...)`.

Line 321 log message: `"Failed to report to dodi_v2"` → `"Failed to report to task ledger"`.

- [ ] **Step 4:** `src/code-index/code-search-mcp-server.ts:39` — change repo enum to free-form string.

Replace:

```typescript
      repo: z.enum(["hive", "dodi_v2"]).optional().describe("Filter to a specific repo. Default: search both"),
```

with:

```typescript
      repo: z.string().optional().describe("Filter to a specific repo by name (matches the `repo` field on indexed records). Default: search all indexed repos."),
```

The downstream filter at line 51 (`if (repo) must.push({ key: "repo", match: { value: repo } });`) already takes a string — no further change needed.

- [ ] **Step 5:** `src/code-task/knowledge-extractor.ts:46` — sanitize prompt template.

Replace the line:

```
- repo: which repo (hive or dodi_v2), infer from the working directory or file paths
```

with:

```
- repo: which repository this file belongs to, inferred from the working directory or file paths
```

- [ ] **Step 6:** `src/code-task/code-task-mcp-server.ts:80` — sanitize tool description string.

The line currently reads (inside the `code_task_spawn` tool description):

```typescript
      "and dodi-dev plugin skills. You will be notified in this thread when the session completes or needs input. " +
```

Replace `"and dodi-dev plugin skills."` with `"and any configured plugin skills."`.

- [ ] **Step 7:** `src/contacts/contacts-mcp-server.ts` — sanitize source-field comment and tool description.

(a) Line 35 (type comment, stripped by minifier but worth fixing for clarity): replace `source: string; // hubspot, quo, google, manual` with `source: string; // e.g. crm, sms, email, manual`.

(b) Line 300 (Zod tool description string — **survives minification, will fail the guardrail**): replace:

```typescript
      source: z.string().optional().describe("Filter by source (hubspot, quo, google, manual)"),
```

with:

```typescript
      source: z.string().optional().describe("Filter by source system (e.g. crm, sms, email, manual)"),
```

- [ ] **Step 8:** `src/linear/linear-mcp-server.ts:89` — sanitize tool description example.

The line currently reads:

```typescript
      assigneeEmail: z.string().optional().describe("Filter by assignee email address (e.g. bot@dodihome.com)"),
```

The `dodihome.com` example contains the substring `dodi`. Replace with a generic example:

```typescript
      assigneeEmail: z.string().optional().describe("Filter by assignee email address (e.g. user@example.com)"),
```

- [ ] **Step 9:** `src/github/github-issues-mcp-server.ts:8` — sanitize doc comment example (cosmetic; minifier strips comments, but tidy while here).

Replace `*   GITHUB_REPO  — owner/repo (required, e.g. "dodihome/hive")` with `*   GITHUB_REPO  — owner/repo (required, e.g. "owner/repo")`.

- [ ] **Step 10:** Verify no remaining contamination in src/ (excluding archetype tests, which are not bundled).

Run (shell): `rg -i "dodi|hubspot|cabinet" src/ --glob "*.ts" -l`

Expected hits — all acceptable, do not modify:
- `src/archetypes/**/*.test.ts` — test fixtures using `/Users/mokie/dev/dodi_v2` as a workspace path example. Test files are not bundled.
- `src/archetypes/slug.ts`, `src/archetypes/slug.test.ts` — comments and tests, not in bundle output.
- `src/contacts/import-hubspot.ts` — standalone CLI script, not in `build/bundle.ts` `entryPoints`. Not bundled.
- `src/migrations/001-backfill-home-base.test.ts`, `src/channels/ws/ws-adapter.test.ts`, `src/channels/dispatcher.test.ts` — test files only.
- `src/workflow/task-core.ts` — vendoring attribution comment (stripped by minifier).
- Any file already addressed in earlier steps of this task (the source still contains `dodi_v2` only inside docstrings/comments that the minifier strips — confirmed at the bundle stage in Task 11).

Any **unexpected** hit (a string literal, a Zod description, a tool name) must be sanitized before continuing. The bundle guardrail in Task 11 is the final gate — if it fails, return to this step.

- [ ] **Step 11:** Run the test suite to catch any broken renames.

Run: `npm run test`
Expected: green.

- [ ] **Step 12:** Commit.

```bash
git add src/tasks/task-ledger.ts src/tasks/task-mcp-server.ts src/sweeper/sweeper.ts \
  src/code-index/code-search-mcp-server.ts src/code-task/knowledge-extractor.ts \
  src/code-task/code-task-mcp-server.ts src/contacts/contacts-mcp-server.ts \
  src/linear/linear-mcp-server.ts src/github/github-issues-mcp-server.ts
git commit -m "chore: sanitize residual dodi/hubspot string leaks in core"
```

---

### Task 10: Default instance id rename

**Files:**
- Modify: `setup/setup-instance.ts:104`

- [ ] **Step 1:** Replace:

```typescript
  const defaultId = currentId ?? "dodi";
```

with:

```typescript
  const defaultId = currentId ?? "hive";
```

- [ ] **Step 2:** Verify and commit.

```bash
git add setup/setup-instance.ts
git commit -m "chore(setup): default instance id to 'hive' instead of 'dodi'"
```

---

### Task 11: CI guardrail — bundle string check

Spec §11 step 10. Fails the build if any forbidden plugin-specific string lands in the bundled output that ships to customers.

**Files:**
- Create: `scripts/check-bundle-strings.mjs`
- Modify: CI workflow file (locate via `Glob .github/workflows/*.yml`)
- Modify: `package.json` — add `check:bundle` script

- [ ] **Step 1:** Create the guardrail script.

```javascript
// scripts/check-bundle-strings.mjs
/**
 * Bundle string guardrail — fails CI if any forbidden plugin-specific string
 * appears in pkg/*.min.js. Spec: docs/specs/2026-04-14-plugin-architecture-design.md §11 step 10.
 *
 * The pkg/ directory is what gets shipped in the @keepur/hive npm tarball;
 * a customer running `hive doctor` should see zero references to dodi,
 * hubspot, or cabinet in their installed copy.
 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const FORBIDDEN = ["dodi", "hubspot", "cabinet"];
const PKG_DIR = "pkg";

if (!existsSync(PKG_DIR)) {
  console.error(`error: ${PKG_DIR}/ not found — run 'npm run bundle' first`);
  process.exit(1);
}

const bundleFiles = readdirSync(PKG_DIR).filter((f) => f.endsWith(".min.js"));
if (bundleFiles.length === 0) {
  console.error(`error: no .min.js files found in ${PKG_DIR}/`);
  process.exit(1);
}

let totalHits = 0;
for (const file of bundleFiles) {
  const path = join(PKG_DIR, file);
  const content = readFileSync(path, "utf8").toLowerCase();
  for (const term of FORBIDDEN) {
    const matches = content.split(term).length - 1;
    if (matches > 0) {
      console.error(`FAIL ${path}: ${matches} occurrence(s) of "${term}"`);
      totalHits += matches;
    }
  }
}

if (totalHits > 0) {
  console.error(`\nTotal: ${totalHits} forbidden string(s) in bundle. Customer-facing tarball is contaminated.`);
  console.error(`See docs/specs/2026-04-14-plugin-architecture-design.md §11 step 10.`);
  process.exit(1);
}

console.log(`OK: ${bundleFiles.length} bundle file(s) clean of forbidden strings (${FORBIDDEN.join(", ")})`);
```

- [ ] **Step 2:** Add an npm script.

In `package.json` `scripts`, add:

```json
"check:bundle": "npm run bundle && node scripts/check-bundle-strings.mjs"
```

- [ ] **Step 3:** Add the step to CI.

Locate the CI workflow file (`.github/workflows/check.yml` or similar — confirm with `Glob .github/workflows/*.yml`). Add a step after the existing `npm run check` step:

```yaml
      - name: Bundle decontamination check
        run: npm run check:bundle
```

- [ ] **Step 4:** Verify locally.

Run: `npm run check:bundle`
Expected: `OK: <N> bundle file(s) clean of forbidden strings (dodi, hubspot, cabinet)`

If it fails, the script's error output names the files and counts. Re-run Task 9 verification to find the leak source — the contamination is upstream of this script, not in it.

- [ ] **Step 5:** Commit.

```bash
git add scripts/check-bundle-strings.mjs package.json .github/workflows/check.yml
git commit -m "ci: add bundle decontamination guardrail"
```

---

### Task 12: Final verification

- [ ] **Step 1:** Full check.

Run: `npm run check && npm run check:bundle`
Expected: all green; `OK: ... clean of forbidden strings`.

- [ ] **Step 2:** Manual sanity check on the dodi plugin.

Confirm `plugins/dodi/plugin.yaml` parses and the agent runner resolves `metadata.dodiOpsMode` correctly by running the relevant test directly:

Run: `npx vitest run src/agents/agent-runner.test.ts -t "agentEnv"`
Expected: the test added in Task 2 passes.

- [ ] **Step 3:** Confirm spec acceptance criteria.

Re-read spec §11 verification block:

- [ ] `npm run bundle && grep -c "dodi\|hubspot\|cabinet" pkg/server.min.js pkg/cli.min.js` → **0 hits**
- [ ] `npm run check` green
- [ ] dodi plugin still loads on the dodi-hive deploy (the in-tree manifest is still there, the seeds still reference `metadata`, and Tasks 2–5 landed atomically so the resolver can read the new path)
- [ ] CI guardrail script wired

- [ ] **Step 4:** Open the PR (use `dodi-dev:submit`).

---

## Appendix: Files NOT touched in this plan (and why)

These appear in grep results for `dodi|hubspot` but are intentionally left alone:

- **`src/archetypes/**/*.test.ts`** — test fixtures using `/Users/mokie/dev/dodi_v2` as a real workspace path example. Test files are not bundled; the CI guardrail only checks `pkg/*.min.js`.
- **`src/archetypes/slug.ts`** JSDoc comment — minifier strips comments; not in bundle.
- **`docs/plans/*` and `docs/specs/*`** — historical plans and the locked spec itself. Not source.
- **`docs/main/plugin-architecture/*` and `docs/DOD-209/*`** — older design docs.
- **Resend MCP server file (only the BCC env var is renamed)** — the rest of the file stays in `src/`. Resend extraction to a plugin is explicit non-scope per spec §11.
- **Task ledger code (only comments are sanitized)** — full task system rewrite is tracked in #138.
- **`plugins/dodi/agent-seeds/*` other than the two with `dodiOpsMode`** — they don't reference any of the deleted core fields.
- **`HUBSPOT_BCC_OUTGOING` env var fallback in `config.ts`** — kept for one release as a deploy-continuity bridge; remove once dodi-hive `.env` migrates.

## Appendix: Atomic commit groups summary

| Commit | Tasks | Why grouped |
|--------|-------|-------------|
| 1 | Task 1 | Standalone — adds infrastructure, no behavior change |
| 2 | Tasks 2, 3, 4, 5 | Resolver + type change + plugin manifest + seeds — any subset breaks dodi-hive |
| 3 | Tasks 6, 7 | Catalog deletes + capability test rewrite — invariant test fails standalone |
| 4 | Task 8 | Resend BCC rename — three sites linked |
| 5 | Task 9 | Comment/string sanitization — independent |
| 6 | Task 10 | Default instance id rename — independent |
| 7 | Task 11 | CI guardrail — independent, runs last to verify the full set |
