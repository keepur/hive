# Plugin MCP Server `secretEnv` Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Give plugin MCP servers the same env-first-then-keychain secret resolution that core servers already get via `config.ts`, by adding a new optional `secret-env` manifest field. Unblocks Phase E of the 0.2.0 migration (trimming secrets from dodi's `.env` once they live in Honeypot).

**Architecture:** Extract `fromKeychain` from `config.ts` into a standalone module so the plugin code paths (agent-runner, instance-capabilities) can reuse it without importing `config.ts`. Add `secret-env: string[]` to the plugin manifest schema — parallel to existing `env: string[]`. `env` stays pass-through-only; `secret-env` falls back to Keychain. Agent-runner injects both. Introspection checks both.

**Tech stack:** TypeScript (strict), Vitest, YAML manifests, macOS `security` CLI.

**Spec reference:** `docs/specs/2026-04-23-plugin-secret-env-design.md`

---

## File Map

**Create:**
- `src/keychain/from-keychain.ts` — extracted `fromKeychain(instanceId, key)` helper
- `src/keychain/from-keychain.test.ts` — unit tests (mock `execFileSync`)

**Modify:**
- `src/config.ts` — import extracted helper, wrap into existing `fromKeychain(key)` closure
- `src/plugins/types.ts` — add `secretEnv?: string[]` to `PluginMcpServer`
- `src/plugins/plugin-loader.ts` — `normalizeManifest` reads `secret-env` into per-server `secretEnv`
- `src/plugins/plugin-loader.test.ts` — add cases for `secret-env` YAML → `secretEnv` TS
- `src/agents/agent-runner.ts` — add `secretEnv` injection loop
- `src/tools/instance-capabilities.ts` — extend plugin-server check to include `secretEnv`
- `src/tools/instance-capabilities.test.ts` — add cases for `secretEnv` resolution
- `plugins/dodi/plugin.yaml` — move credentialed vars from `env` to `secret-env`
- `CLAUDE.md` — note `secretEnv` field

---

## Task 1: Extract `fromKeychain` into shared module

**Files:**
- Create: `src/keychain/from-keychain.ts`
- Create: `src/keychain/from-keychain.test.ts`

- [ ] **Step 1:** Create the helper.

```typescript
// src/keychain/from-keychain.ts
import { execFileSync } from "node:child_process";

/**
 * Read a credential from macOS Keychain under the Honeypot namespace
 * (`hive/<instanceId>/<key>`). Returns "" on non-darwin, on missing entry,
 * or on any other `security` failure — matches the lenient semantics of
 * `config.ts`'s `optional()`.
 */
export function fromKeychain(instanceId: string, key: string): string {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", `hive/${instanceId}/${key}`, "-w"],
      { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] },
    ).trim();
  } catch {
    return "";
  }
}
```

- [ ] **Step 2:** Create the test.

```typescript
// src/keychain/from-keychain.test.ts
import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import { execFileSync } from "node:child_process";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
}));

const mockExecFileSync = vi.mocked(execFileSync);

describe("fromKeychain", () => {
  const origPlatform = process.platform;

  beforeEach(() => {
    vi.clearAllMocks();
    Object.defineProperty(process, "platform", { value: "darwin", configurable: true });
  });

  afterAll(() => {
    Object.defineProperty(process, "platform", { value: origPlatform, configurable: true });
  });

  it("returns trimmed value on success", async () => {
    mockExecFileSync.mockReturnValue("secret-value\n" as any);
    const { fromKeychain } = await import("./from-keychain.js");
    expect(fromKeychain("test-inst", "MY_KEY")).toBe("secret-value");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "hive/test-inst/MY_KEY", "-w"],
      expect.objectContaining({ encoding: "utf-8" }),
    );
  });

  it("returns \"\" when security command fails (entry missing)", async () => {
    mockExecFileSync.mockImplementation(() => {
      throw new Error("not found");
    });
    const { fromKeychain } = await import("./from-keychain.js");
    expect(fromKeychain("test-inst", "MISSING")).toBe("");
  });

  it("returns \"\" on non-darwin without invoking security", async () => {
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    const { fromKeychain } = await import("./from-keychain.js");
    expect(fromKeychain("test-inst", "ANY")).toBe("");
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("scopes the service name by instanceId", async () => {
    mockExecFileSync.mockReturnValue("v" as any);
    const { fromKeychain } = await import("./from-keychain.js");
    fromKeychain("keepur", "FOO");
    expect(mockExecFileSync).toHaveBeenCalledWith(
      "security",
      ["find-generic-password", "-s", "hive/keepur/FOO", "-w"],
      expect.anything(),
    );
  });
});
```

- [ ] **Step 3:** Verify.

```bash
npm run typecheck
npx vitest run src/keychain/from-keychain.test.ts
```

Expected: typecheck passes; 4 tests pass.

- [ ] **Step 4:** Commit.

```bash
git add src/keychain/from-keychain.ts src/keychain/from-keychain.test.ts
git commit -m "feat(keychain): extract fromKeychain helper for reuse outside config.ts"
```

---

## Task 2: Update `config.ts` to use extracted helper

**Files:**
- Modify: `src/config.ts:5` (drop unused `execFileSync` import if no other use), `src/config.ts:50-61` (remove inline `fromKeychain`), add adapter closure right after `instanceId` declaration (line 48)

- [ ] **Step 1:** Replace inline `fromKeychain` with adapter over the extracted helper.

Find at `src/config.ts` around line 48-61:

```typescript
// Instance identity — single source of truth for multi-instance derivation
const instanceId = (hive.instance?.id as string) ?? "hive";

/** Try to read a credential from macOS Keychain (honeypot-stored). */
function fromKeychain(key: string): string {
  if (process.platform !== "darwin") return "";
  try {
    return execFileSync("security", ["find-generic-password", "-s", `hive/${instanceId}/${key}`, "-w"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
  } catch {
    return "";
  }
}
```

Replace with:

```typescript
// Instance identity — single source of truth for multi-instance derivation
const instanceId = (hive.instance?.id as string) ?? "hive";

/** Closure over `instanceId` — lets `required()` / `optional()` stay unchanged. */
const fromKeychain = (key: string) => fromKeychainRaw(instanceId, key);
```

Add import at top of `src/config.ts` (with the other imports, around line 1-8):

```typescript
import { fromKeychain as fromKeychainRaw } from "./keychain/from-keychain.js";
```

- [ ] **Step 2:** Drop the now-unused `execFileSync` import.

Remove `import { execFileSync } from "node:child_process";` at `src/config.ts:5`. (The inline `fromKeychain` was the sole consumer — confirm with `grep -n execFileSync src/config.ts` before removing; should show no remaining matches.)

- [ ] **Step 3:** Verify.

```bash
npm run typecheck
npx vitest run
```

Expected: typecheck passes; full test suite still green (no behavioral change to `required()` / `optional()`).

- [ ] **Step 4:** Commit.

```bash
git add src/config.ts
git commit -m "refactor(config): use extracted fromKeychain helper"
```

---

## Task 3: Add `secretEnv` to manifest schema + loader

**Files:**
- Modify: `src/plugins/types.ts:1-11`
- Modify: `src/plugins/plugin-loader.ts:103-116`
- Modify: `src/plugins/plugin-loader.test.ts` (extend existing cases)

- [ ] **Step 1:** Add `secretEnv?: string[]` to `PluginMcpServer`.

Find at `src/plugins/types.ts:1-11`:

```typescript
export interface PluginMcpServer {
  entry: string;
  description?: string;
  /** When to use this server — guidance for agents */
  usage?: string;
  /** Common misuse — "for X, use Y instead" */
  notFor?: string;
  env?: string[]; // pass-through from base env (same name)
  envMap?: Record<string, string>; // rename: SERVER_VAR -> BASE_VAR
  agentEnv?: Record<string, string>;
}
```

Replace with:

```typescript
export interface PluginMcpServer {
  entry: string;
  description?: string;
  /** When to use this server — guidance for agents */
  usage?: string;
  /** Common misuse — "for X, use Y instead" */
  notFor?: string;
  env?: string[]; // pass-through from base env (same name); no keychain fallback
  /** Secret vars resolved via process.env first, macOS Keychain (honeypot) second. */
  secretEnv?: string[];
  envMap?: Record<string, string>; // rename: SERVER_VAR -> BASE_VAR
  agentEnv?: Record<string, string>;
}
```

- [ ] **Step 2:** Wire `secret-env` through `normalizeManifest`.

Find at `src/plugins/plugin-loader.ts:103-115` (inside the per-server object literal):

```typescript
    mcpServers: Object.fromEntries(
      Object.entries(raw["mcp-servers"] ?? {}).map(([k, v]: [string, any]) => [
        k,
        {
          entry: v.entry,
          description: v.description,
          usage: v.usage,
          notFor: v["not-for"],
          env: v.env ?? [],
          envMap: v["env-map"] ?? {},
          agentEnv: v["agent-env"] ?? {},
        },
      ]),
    ),
```

Replace with:

```typescript
    mcpServers: Object.fromEntries(
      Object.entries(raw["mcp-servers"] ?? {}).map(([k, v]: [string, any]) => [
        k,
        {
          entry: v.entry,
          description: v.description,
          usage: v.usage,
          notFor: v["not-for"],
          env: v.env ?? [],
          secretEnv: v["secret-env"] ?? [],
          envMap: v["env-map"] ?? {},
          agentEnv: v["agent-env"] ?? {},
        },
      ]),
    ),
```

**Critical:** `secretEnv` goes inside the per-server object literal, parallel to `env`. Not at the outer `PluginManifest` level.

- [ ] **Step 3:** Extend existing tests to cover `secretEnv`.

In `src/plugins/plugin-loader.test.ts`:

Update the "normalizes a full manifest with all fields" test (~line 20-49) to include `secret-env`:

```typescript
  it("normalizes a full manifest with all fields", () => {
    const raw = {
      name: "test-plugin",
      description: "A test plugin",
      "mcp-servers": {
        "my-server": {
          entry: "mcp-servers/my-server/index.ts",
          env: ["API_KEY"],
          "secret-env": ["SECRET_TOKEN"],
          "env-map": { SERVER_URL: "BASE_URL" },
          "agent-env": { MODE: "agentMode" },
        },
      },
      "agents-templates": ["agent-a", "agent-b"],
    };

    const result = normalizeManifest(raw);

    expect(result.name).toBe("test-plugin");
    expect(result.description).toBe("A test plugin");
    expect(result.agentSeeds).toEqual(["agent-a", "agent-b"]);
    expect(result.mcpServers["my-server"]).toEqual({
      entry: "mcp-servers/my-server/index.ts",
      description: undefined,
      usage: undefined,
      notFor: undefined,
      env: ["API_KEY"],
      secretEnv: ["SECRET_TOKEN"],
      envMap: { SERVER_URL: "BASE_URL" },
      agentEnv: { MODE: "agentMode" },
    });
  });
```

Update the "defaults missing server sub-fields" test (~line 89-105) to expect `secretEnv: []`:

```typescript
  it("defaults missing server sub-fields", () => {
    const raw = {
      "mcp-servers": {
        simple: { entry: "index.ts" },
      },
    };
    const result = normalizeManifest(raw);
    expect(result.mcpServers.simple).toEqual({
      entry: "index.ts",
      description: undefined,
      usage: undefined,
      notFor: undefined,
      env: [],
      secretEnv: [],
      envMap: {},
      agentEnv: {},
    });
  });
```

Add a new focused test just after "defaults missing server sub-fields":

```typescript
  it("round-trips secret-env (YAML) to secretEnv (TS)", () => {
    const raw = {
      "mcp-servers": {
        "s": { entry: "e.ts", "secret-env": ["A", "B", "C"] },
      },
    };
    const result = normalizeManifest(raw);
    expect(result.mcpServers.s.secretEnv).toEqual(["A", "B", "C"]);
    expect(result.mcpServers.s.env).toEqual([]);
  });
```

- [ ] **Step 4:** Verify.

```bash
npm run typecheck
npx vitest run src/plugins/plugin-loader.test.ts
```

Expected: typecheck passes; plugin-loader tests all pass (updated + new).

- [ ] **Step 5:** Commit.

```bash
git add src/plugins/types.ts src/plugins/plugin-loader.ts src/plugins/plugin-loader.test.ts
git commit -m "feat(plugins): add secret-env manifest field with Keychain fallback"
```

---

## Task 4: Inject `secretEnv` in `agent-runner.ts`

**Files:**
- Modify: `src/agents/agent-runner.ts:673-675` (add loop after existing `env` loop)

`config` is already imported at the top of `agent-runner.ts` (grep to confirm: `grep -n 'from "../config.js"' src/agents/agent-runner.ts`) — so `config.instance.id` is available without touching the existing import. Only `fromKeychain` needs to be added.

- [ ] **Step 1:** Add import to top of `src/agents/agent-runner.ts` (alongside other imports):

```typescript
import { fromKeychain } from "../keychain/from-keychain.js";
```

- [ ] **Step 2:** Add the `secretEnv` injection loop.

Find at `src/agents/agent-runner.ts:673-675`:

```typescript
        for (const envVar of serverDef.env ?? []) {
          if (process.env[envVar]) env[envVar] = process.env[envVar]!;
        }

        // env-map: rename base env vars (e.g. DODI_OPS_API_URL -> TASK_LEDGER_API_URL)
```

Replace with:

```typescript
        for (const envVar of serverDef.env ?? []) {
          if (process.env[envVar]) env[envVar] = process.env[envVar]!;
        }

        for (const envVar of serverDef.secretEnv ?? []) {
          const value = process.env[envVar] || fromKeychain(config.instance.id, envVar);
          if (value) env[envVar] = value;
        }

        // env-map: rename base env vars (e.g. DODI_OPS_API_URL -> TASK_LEDGER_API_URL)
```

Order rationale (spec, lines 100-101): `secretEnv` runs after `env` so that if a manifest author accidentally double-lists a var, the keychain lookup still has a chance to fill it. The two loops are conceptually disjoint; manifest authors should pick exactly one field per var.

- [ ] **Step 3:** Verify.

```bash
npm run typecheck
npx vitest run src/agents
```

Expected: typecheck passes; agent tests still green.

- [ ] **Step 4:** Commit.

```bash
git add src/agents/agent-runner.ts
git commit -m "feat(agent-runner): inject secretEnv vars from env or Keychain"
```

---

## Task 5: Extend `instance-capabilities.ts` check

**Files:**
- Modify: `src/tools/instance-capabilities.ts:79-90`
- Modify: `src/tools/instance-capabilities.test.ts` (add mock + new cases)

- [ ] **Step 1:** Add `fromKeychain` import to `src/tools/instance-capabilities.ts`:

```typescript
import { fromKeychain } from "../keychain/from-keychain.js";
```

- [ ] **Step 2:** Extend the plugin-server check.

Find at `src/tools/instance-capabilities.ts:79-90`:

```typescript
  // Plugin servers — generic check: configured iff every declared env var is non-empty
  for (const plugin of plugins) {
    for (const [serverName, serverDef] of Object.entries(plugin.manifest.mcpServers)) {
      const requiredEnv = serverDef.env ?? [];
      const hasAll = requiredEnv.length === 0 || requiredEnv.every((envVar) => !!process.env[envVar]);
      if (hasAll) {
        configured.push(serverName);
      } else {
        unconfigured.push(serverName);
      }
    }
  }
```

Replace with:

```typescript
  // Plugin servers — generic check: configured iff every declared env var resolves.
  // `env` must come from process.env; `secretEnv` can fall through to Keychain.
  const instanceId = config.instance?.id ?? "unknown";
  for (const plugin of plugins) {
    for (const [serverName, serverDef] of Object.entries(plugin.manifest.mcpServers)) {
      const requiredEnv = serverDef.env ?? [];
      const requiredSecrets = serverDef.secretEnv ?? [];
      const envOk = requiredEnv.every((v) => !!process.env[v]);
      const secretsOk = requiredSecrets.every((v) => !!process.env[v] || !!fromKeychain(instanceId, v));
      if (envOk && secretsOk) {
        configured.push(serverName);
      } else {
        unconfigured.push(serverName);
      }
    }
  }
```

- [ ] **Step 3:** Add test cases.

In `src/tools/instance-capabilities.test.ts`, at the **top of the file**:

1. After the existing `vi.mock("../config.js", ...)` block (~line 3-19), add a second `vi.mock` for `from-keychain`:

```typescript
vi.mock("../keychain/from-keychain.js", () => ({
  fromKeychain: vi.fn(() => ""),
}));
```

2. Alongside the existing `import { buildInstanceCapabilities, ... }` at ~line 21, add two more top-level imports:

```typescript
import { fromKeychain } from "../keychain/from-keychain.js";
import type { LoadedPlugin } from "../plugins/types.js";
```

3. Below the imports (before the first `describe`), add the mock handle and helper:

```typescript
const mockFromKeychain = vi.mocked(fromKeychain);

function makePlugin(name: string, mcpServers: LoadedPlugin["manifest"]["mcpServers"]): LoadedPlugin {
  return {
    name,
    dir: `/tmp/${name}`,
    manifest: { name, mcpServers, agentSeeds: [] },
  };
}
```

All ESM imports and `vi.mock` calls must be at the top of the file (`import/first` lint rule).

4. Append a new describe block to the bottom of the file (after the existing invariant test):

```typescript
describe("buildInstanceCapabilities — plugin secretEnv", () => {
  beforeEach(() => {
    mockFromKeychain.mockReset();
    mockFromKeychain.mockReturnValue("");
    // Clear any test-leaked process.env overrides
    delete process.env.__TEST_SECRET;
    delete process.env.__TEST_PUBLIC;
  });

  it("marks plugin server configured when secretEnv resolves from process.env", () => {
    process.env.__TEST_SECRET = "s";
    const plugin = makePlugin("p", {
      "srv": { entry: "e.ts", secretEnv: ["__TEST_SECRET"] },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.configured).toContain("srv");
    delete process.env.__TEST_SECRET;
  });

  it("marks plugin server configured when secretEnv resolves from Keychain", () => {
    mockFromKeychain.mockImplementation((_id, key) => (key === "__TEST_SECRET" ? "from-kc" : ""));
    const plugin = makePlugin("p", {
      "srv": { entry: "e.ts", secretEnv: ["__TEST_SECRET"] },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.configured).toContain("srv");
    expect(mockFromKeychain).toHaveBeenCalledWith("test-instance", "__TEST_SECRET");
  });

  it("marks plugin server unconfigured when secretEnv missing from both env and Keychain", () => {
    const plugin = makePlugin("p", {
      "srv": { entry: "e.ts", secretEnv: ["__TEST_SECRET"] },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.unconfigured).toContain("srv");
  });

  it("marks plugin server unconfigured when env var missing (no keychain fallback for env)", () => {
    // Keychain has the value, but it's declared under `env`, not `secretEnv`
    mockFromKeychain.mockReturnValue("from-kc");
    const plugin = makePlugin("p", {
      "srv": { entry: "e.ts", env: ["__TEST_PUBLIC"] },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.unconfigured).toContain("srv");
  });

  it("marks plugin server configured when both env and secretEnv resolve", () => {
    process.env.__TEST_PUBLIC = "p";
    mockFromKeychain.mockReturnValue("from-kc");
    const plugin = makePlugin("p", {
      "srv": { entry: "e.ts", env: ["__TEST_PUBLIC"], secretEnv: ["__TEST_SECRET"] },
    });
    const result = buildInstanceCapabilities([plugin]);
    expect(result.servers.configured).toContain("srv");
    delete process.env.__TEST_PUBLIC;
  });
});
```

- [ ] **Step 4:** Verify.

```bash
npm run typecheck
npx vitest run src/tools/instance-capabilities.test.ts
```

Expected: typecheck passes; all existing tests still pass; 5 new cases pass.

- [ ] **Step 5:** Commit.

```bash
git add src/tools/instance-capabilities.ts src/tools/instance-capabilities.test.ts
git commit -m "feat(capabilities): extend plugin-server check to resolve secretEnv from Keychain"
```

---

## Task 6: Migrate `plugins/dodi/plugin.yaml`

**Files:**
- Modify: `plugins/dodi/plugin.yaml`

Per spec migration table (lines 128-137): move `MONGODB_ATLAS_URI`, `MONGODB_STAGING_URI`, `VOYAGEAI_API_KEY` from `env` to `secret-env` for the three search servers; move `HUBSPOT_API_KEY` to `secret-env` for hubspot-crm. Leave `TASK_LEDGER_API_KEY` in `env` (already injected by agent-runner base env from `config.taskLedger.apiKey`). Leave `PERMITS_MONGO_URI` in `env` (local URI, no embedded creds).

- [ ] **Step 1:** Edit `plugins/dodi/plugin.yaml` — apply changes server by server.

`hubspot-crm` (line 10):
```yaml
    env: [HUBSPOT_API_KEY]
```
→
```yaml
    secret-env: [HUBSPOT_API_KEY]
```
(Remove `env:` line entirely since no non-secret vars remain.)

`crm-search` (line 41):
```yaml
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY, KB_BACKEND]
```
→
```yaml
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, KB_BACKEND]
    secret-env: [MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
```

`product-search` (line 47):
```yaml
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
```
→
```yaml
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL]
    secret-env: [MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
```

`ops-search` (line 53):
```yaml
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
```
→
```yaml
    env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL]
    secret-env: [MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
```

Leave `dodi-ops`, `catalog`, `permits` unchanged — see spec lines 139-141 for why.

- [ ] **Step 2:** Verify YAML still parses.

```bash
npx tsx -e "import { parse } from 'yaml'; import { readFileSync } from 'node:fs'; console.log(JSON.stringify(parse(readFileSync('plugins/dodi/plugin.yaml','utf-8')), null, 2))" | head -80
```

Expected: valid JSON output showing `secret-env` arrays populated on the four updated servers (`hubspot-crm`, `crm-search`, `product-search`, `ops-search`).

- [ ] **Step 3:** Commit.

```bash
git add plugins/dodi/plugin.yaml
git commit -m "chore(dodi): move credentials to secret-env for Honeypot resolution"
```

---

## Task 7: Documentation

**Files:**
- Modify: `CLAUDE.md:100-105` (Plugin MCP Servers section)

- [ ] **Step 1:** Add a one-paragraph note about the manifest fields near the Plugin MCP Servers section.

Find at `CLAUDE.md:100`:

```markdown
### Plugin MCP Servers (`plugins/dodi/`)
- `dodi-ops-mcp-server.ts` — dodi_v2 REST API (persons, projects, designs, jobs, cases, comments, attachments, cutlists)
- `hubspot-crm-mcp-server.ts` — HubSpot CRM read/write
- `catalog-mcp-server.ts` — read-only product catalog access
- `permit-mcp-server.ts` — permit management
```

Replace with:

```markdown
### Plugin MCP Servers (`plugins/dodi/`)
- `dodi-ops-mcp-server.ts` — dodi_v2 REST API (persons, projects, designs, jobs, cases, comments, attachments, cutlists)
- `hubspot-crm-mcp-server.ts` — HubSpot CRM read/write
- `catalog-mcp-server.ts` — read-only product catalog access
- `permit-mcp-server.ts` — permit management

**Manifest env vs. secret-env:** in `plugin.yaml`, list non-secret config (URLs without creds, flags, model names) under `env:` — pass-through from `process.env` only. List credentials (API keys, tokens, credentialed URIs) under `secret-env:` — resolved via `process.env` first, then macOS Keychain (Honeypot: `hive/<instanceId>/<KEY>`). Introspection and runtime injection agree: a `secret-env` var seeded only in Honeypot still works.
```

- [ ] **Step 2:** Commit.

```bash
git add CLAUDE.md
git commit -m "docs: document env vs secret-env in plugin manifests"
```

---

## Final Verification

- [ ] **Step 1:** Full check.

```bash
npm run check
```

Expected: typecheck, lint, format, and full test suite all green.

- [ ] **Step 2:** Smoke manifest loads at runtime.

```bash
npm run build
node -e "
  import('./dist/plugins/plugin-loader.js').then(m => {
    const ps = m.loadPlugins(['dodi'], process.cwd());
    for (const p of ps) for (const [k, v] of Object.entries(p.manifest.mcpServers)) {
      console.log(k, 'env:', v.env, 'secretEnv:', v.secretEnv);
    }
  });
"
```

Expected: seven plugin servers listed; `crm-search`/`product-search`/`ops-search` each show `secretEnv: [MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]`; `hubspot-crm` shows `secretEnv: [HUBSPOT_API_KEY]`.

---

## Out of Scope (flagged, separate ticket)

Per spec lines 143-149: `config.taskLedger.agentKeys` in `src/config.ts:137-140` filters `process.env` directly without Keychain fallback. After dodi's Phase E trims `.env`, per-agent `TASK_LEDGER_KEY_<AGENT>` scoping would disappear. File a follow-up ticket to add Keychain fallback to `agentKeys` population. **Not blocking this PR** — dodi keeps these in `.env` during initial rollout.

---

Plan saved to `docs/plans/2026-04-23-plugin-secret-env.md`. Ready to execute?
