# Plugin MCP Server `secretEnv` — Design Spec

**Date:** 2026-04-23
**Author:** May (CEO) + Claude (Opus)
**Triggered by:** dodi 0.1.x → 0.2.0 migration session — Phase E `.env` trim blocked by plugin server credential resolution gap

## Problem

Hive's `config.ts` resolves secrets via `process.env[KEY] || fromKeychain(KEY) || fallback`. This means core servers (Slack, Linear, HubSpot, etc.) work whether secrets live in `.env` or in Honeypot.

Plugin MCP servers do not get the same treatment. Today:

1. Plugin manifests declare `env: [VAR1, VAR2, ...]`.
2. `agent-runner.ts:673` injects each declared var into the subprocess env from `process.env`.
3. `instance-capabilities.ts` lines 80-89 check `!!process.env[var]` to decide "configured."

If a secret lives only in Honeypot (Keychain) and not in `.env`, both the introspection check and the runtime env injection see it as missing. The plugin server fails to receive its credentials.

This blocks the migration's **Phase E** (trim secrets from `.env` once they're in Honeypot) — every dodi plugin server (`crm-search`, `product-search`, `ops-search`, `dodi-ops`, `catalog`, `permits`) would lose access to MongoDB URIs, embedding keys, and task-ledger keys.

## Goals

1. Plugin MCP servers can receive secrets from Honeypot without code changes inside the server.
2. Manifest authors can declare which env vars are secrets vs. config — making credential dependencies auditable for plugin-registry curation.
3. Introspection report ("configured?") matches runtime reality.
4. Backward compatible — existing manifests without the new field continue to work unchanged.

## Non-goals

- Removing the `env: [...]` field — it remains for non-secret config.
- Changing how core (non-plugin) servers resolve credentials — `config.ts` already handles them correctly.
- Per-agent secret scoping (different secrets per agent for the same server) — separate concern, not blocking Phase E.
- Migrating other Hive instances' plugins — manifest update is per-plugin, owned by the plugin author.

## Design

### Manifest schema

Add an optional `secret-env: string[]` field to the YAML manifest, parallel to the existing `env: string[]`. Note: `plugin.yaml` uses **kebab-case** keys — `mcp-servers`, `env-map`, `agent-env`, `not-for`. `plugin-loader.ts:98-120` (`normalizeManifest`) translates these into camelCase for the `PluginMcpServer` TypeScript interface. The new field follows the same convention: `secret-env:` in YAML → `secretEnv` in TS.

```yaml
crm-search:
  entry: mcp-servers/crm-search/crm-search-mcp-server.ts
  env: [OLLAMA_URL, QDRANT_URL, KB_EMBED_MODEL, KB_BACKEND]
  secret-env: [MONGODB_ATLAS_URI, MONGODB_STAGING_URI, VOYAGEAI_API_KEY]
```

**Semantics:**
- `env`: pass-through from `process.env`. No Keychain fallback. Used for non-secret config — URLs without credentials, IDs, flags, file paths, model names.
- `secret-env` (TS: `secretEnv`): resolved via `process.env[KEY] || fromKeychain(instanceId, KEY)`. Same precedence as `config.ts`'s `optional()/required()` — env wins, keychain second, no fallback default.

### Resolution

Extract `fromKeychain` from `src/config.ts` into a new shared module so the plugin loader can use it without circular dependencies:

```ts
// src/keychain/from-keychain.ts
import { execFileSync } from "node:child_process";

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

**Call-site strategy inside `config.ts`**: the existing `fromKeychain` in `config.ts` is a closure over module-level `instanceId` and is called as `fromKeychain(key)` from `required()` (line 15) and `optional()` (line 21). After extraction, do NOT change `required()`/`optional()` bodies — add a private adapter:

```ts
// src/config.ts — after the instanceId line
import { fromKeychain as fromKeychainRaw } from "./keychain/from-keychain.js";
const fromKeychain = (key: string) => fromKeychainRaw(instanceId, key);
```

Internal callers keep using `fromKeychain(key)` with zero body changes. `agent-runner.ts` and `instance-capabilities.ts` import `fromKeychainRaw` (or the exported two-arg name) directly and pass `config.instance.id` each call. This keeps the refactor surgical — only the module-level `fromKeychain` definition moves out, and `required()`/`optional()` untouched.

### `agent-runner.ts` injection

Add a `secretEnv` loop next to the existing `env` loop. Note: `instanceId` is not a local variable in agent-runner.ts:660-691 — it must be pulled from `config.instance.id` (imported as `config` from `../config.js`).

```ts
// existing (line 673-675)
for (const envVar of serverDef.env ?? []) {
  if (process.env[envVar]) env[envVar] = process.env[envVar]!;
}

// new — add after the env loop, before envMap
for (const envVar of serverDef.secretEnv ?? []) {
  const value = process.env[envVar] || fromKeychain(config.instance.id, envVar);
  if (value) env[envVar] = value;
}
```

Order note: `secretEnv` runs after `env` so any key left unset by the `env` loop (because it was absent from `process.env` — the loop has an `if (process.env[envVar])` guard) still gets a chance to fill from keychain. There is no meaningful override semantics between the two loops — they target disjoint failure modes. Manifest authors should not list the same key in both; the guidance is "pick one" based on whether the var is a secret.

### `instance-capabilities.ts` introspection

Update the plugin-server check to validate both lists. Same `instanceId`-scope note — use `config.instance.id`.

```ts
const requiredEnv = serverDef.env ?? [];
const requiredSecrets = serverDef.secretEnv ?? [];
const envOk = requiredEnv.every((v) => !!process.env[v]);
const secretsOk = requiredSecrets.every(
  (v) => !!process.env[v] || !!fromKeychain(config.instance.id, v),
);
const hasAll = envOk && secretsOk;
```

### Failure mode

**Lenient.** A plugin server whose `secretEnv` resolves to nothing still spawns. It will fail at first credential use (the same way it fails today if `.env` is missing the var). This matches `config.ts`'s `optional()` semantics — startup never fails on missing creds, only first use does.

**Rationale:** strict-spawn-refusal would mean a single missing key blocks an entire agent. Lenient lets agents partially function and surface clearer errors at the call site.

The introspection report is the right place to surface the gap proactively. Mokie/beekeeper agents see "X unconfigured" and can act.

## Migration of `plugins/dodi/plugin.yaml`

Move the following from `env` to `secret-env` per server:

| Server | Move to `secret-env` | Stay in `env` |
|---|---|---|
| `dodi-ops` | (none — see note) | `TASK_LEDGER_API_URL`, `TASK_LEDGER_API_KEY` |
| `catalog` | (none — see note) | `TASK_LEDGER_API_URL`, `TASK_LEDGER_API_KEY` |
| `permits` | (none — `PERMITS_MONGO_URI` has no embedded creds; see note) | `PERMITS_MONGO_URI` |
| `crm-search` | `MONGODB_ATLAS_URI`, `MONGODB_STAGING_URI`, `VOYAGEAI_API_KEY` | `OLLAMA_URL`, `QDRANT_URL`, `KB_EMBED_MODEL`, `KB_BACKEND` |
| `product-search` | `MONGODB_ATLAS_URI`, `MONGODB_STAGING_URI`, `VOYAGEAI_API_KEY` | `OLLAMA_URL`, `QDRANT_URL`, `KB_EMBED_MODEL` |
| `ops-search` | `MONGODB_ATLAS_URI`, `MONGODB_STAGING_URI`, `VOYAGEAI_API_KEY` | `OLLAMA_URL`, `QDRANT_URL`, `KB_EMBED_MODEL` |
| `hubspot-crm` | `HUBSPOT_API_KEY` | (none) |

**Why `TASK_LEDGER_API_KEY` stays in `env` (not `secret-env`):** `agent-runner.ts:661-671` already injects both `TASK_LEDGER_API_URL` and `TASK_LEDGER_API_KEY` into every plugin server's base env from `config.taskLedger` (which uses `optional()` with keychain fallback). So these values reach plugin subprocesses regardless of what the manifest declares. The manifest listing them in `env:` is documentation-as-code — plugin authors reading `plugin.yaml` see what the server consumes — without changing runtime behavior.

**Why `PERMITS_MONGO_URI` stays in `env` (not `secret-env`):** it's a local Mongo URI with no embedded credentials — consistent with how local URLs are handled elsewhere. The permit MCP server has its own internal default (`mongodb://localhost:27017/permits` at `permit-mcp-server.ts:18`), so the subprocess still works if the var is unset. That said, Phase E should keep `PERMITS_MONGO_URI` in `.env` for clarity — the `config.ts` default at line 195 is for Hive's own permits consumer, not the subprocess env.

### Orthogonal gap discovered during spec review (out of scope here)

`config.taskLedger.agentKeys` in `src/config.ts:137-140` builds the per-agent `TASK_LEDGER_KEY_<AGENT>` map by filtering `process.env` **directly, without `optional()` / keychain fallback**. After Phase E trims `.env`, those per-agent keys disappear and agent-runner falls back to the generic `config.taskLedger.apiKey` (which does have keychain fallback — if seeded in Honeypot as `TASK_LEDGER_API_KEY`).

Today, dodi's Honeypot has `TASK_LEDGER_KEY_CHIEF_OF_STAFF`, `…_SDR`, etc. seeded but **not** a generic `TASK_LEDGER_API_KEY`. So Phase E would make every agent share the same (missing) generic key — losing per-agent scoping.

**Separate ticket required** to extend `agentKeys` population with keychain fallback. Flag for follow-up; not blocking this spec's rollout since dodi's `.env` stays intact during the initial land.

## Files

### New
- `src/keychain/from-keychain.ts` — extracted `fromKeychain` helper
- `src/keychain/from-keychain.test.ts` — unit tests for the helper (mock `execFileSync`)

### Modified
- `src/config.ts` — import `fromKeychain` from new module instead of inline (signature changes: accepts `instanceId` as first param)
- `src/plugins/types.ts` — add `secretEnv?: string[]` to `PluginMcpServer`
- `src/plugins/plugin-loader.ts` — in `normalizeManifest`, add `secretEnv: v["secret-env"] ?? []` **inside the per-server object literal** (parallel to `notFor: v["not-for"]` at line 110), NOT at the outer `mcpServers` level. Wrong placement makes the field land on `PluginManifest` instead of each `PluginMcpServer` and silently break every downstream `serverDef.secretEnv` read.
- `src/agents/agent-runner.ts` — add `secretEnv` loop after existing `env` loop (~6 lines, uses `config.instance.id` since no `instanceId` local in scope)
- `src/tools/instance-capabilities.ts` — extend plugin-server configured check (~8 lines, same `config.instance.id` usage)
- `src/tools/instance-capabilities.test.ts` — add cases for `secretEnv` resolution from keychain
- `src/plugins/plugin-loader.test.ts` — verify `secret-env` (YAML) round-trips to `secretEnv` (TS) through `normalizeManifest`
- `plugins/dodi/plugin.yaml` — add `secret-env:` keys per the migration table above

### Docs
- `CLAUDE.md` — note `secretEnv` field in MCP servers section
- `docs/architecture.md` (if it documents plugin manifests) — schema update

## Backward compatibility

- `secretEnv` is optional. Manifests without it parse and run unchanged.
- `env` semantics unchanged — pass-through from `process.env`, no keychain.
- No subprocess (plugin server) code changes — they continue reading `process.env[X]`.
- Plugin-registry consumers see new optional field — registry validation should accept manifests with or without it.

## Tests

| Layer | Test |
|---|---|
| `from-keychain` | Returns value when `security find-generic-password` succeeds; returns `""` on non-darwin; returns `""` on missing entry |
| `agent-runner` env injection | Plugin server env contains `secretEnv` values resolved from `process.env`; falls through to keychain when env empty; uses env when both present |
| `instance-capabilities` | Plugin reports `configured` when all `env` + `secretEnv` resolve; reports `unconfigured` when any `secretEnv` missing from both env and keychain |
| `plugin-loader` | `secretEnv` field parses correctly; missing `secretEnv` defaults to empty array |

## Risks

| Risk | Mitigation |
|---|---|
| Refactoring `fromKeychain` extraction breaks existing config.ts call sites | Keep signature compatible; covered by existing config.ts tests; smoke-test on dodi instance after deploy |
| `secretEnv` keychain reads add startup latency (one `security` shell-out per declared secret per agent) | Each call ~10-30ms on warm cache; agent has typically 0-3 plugin secrets; acceptable. Cache opportunity if measured slow. |
| Plugin authors confused about `env` vs `secretEnv` boundary | Doc with clear examples (URLs/flags/IDs → env; keys/tokens/credentialed URIs → secretEnv) |

## Rollout

1. Land PR to main → published in next 0.2.x release.
2. Update `plugins/dodi/plugin.yaml` in same PR (lives in the same repo).
3. After deploy: dodi instance's plugin servers continue working from `.env` (env-first resolution).
4. **Phase E unblock**: trim secrets from dodi `.env`, restart, confirm Mokie introspection shows all plugin servers still configured (now resolving from keychain).
5. Document the new manifest field in plugin-author guide for third-party plugins.

## Open decisions

All resolved during brainstorm:

- **Lenient vs strict on missing secret** → lenient (matches `config.ts` semantics)
- **`env` vs `secretEnv` boundary** → secrets only (keys, tokens, credentialed URIs); everything else stays in `env`
- **`PERMITS_MONGO_URI` classification** → `env` (local URI, no creds embedded)
- **Inject vs runtime keychain calls** → inject at spawn (subprocess code stays dumb, consistent with current pattern)
