# Plugin Architecture Design

**Status:** Locked — 2026-04-15 (4 review rounds)
**Author:** Mokie + Claude (brainstorm session 2026-04-14)
**Related:** Issue #135 (core decontamination), #137 (skills, follow-on), #138 (native tasks, follow-on), #139 (vault/honeypot, long-term)

---

## 1. Problem

Hive's current plugin system is half-formed. Core code hardcodes plugin-specific entries (`config.hubspot`, `dodiOpsMode`, dodi/hubspot MCP servers in `SERVER_CATALOG`, dodi/hubspot credential checks in `instance-capabilities.ts`) that should come from plugin manifests. Smoke-testing the packed tarball from #109 showed DodiHome strings leaking into `pkg/server.min.js`, blocking first-customer install on the private npm registry.

The symptom is contamination. The cause is that the existing "plugin" concept — `plugins/dodi/` as an in-tree bundle containing MCP servers + agent seeds + everything else needed for one customer — has never had a clean definition. Core grew plugin-specific fields and catalog entries as shortcuts because the alternative (a properly specified plugin contract) didn't exist.

This spec defines what a plugin *is*, where plugins live, how they load, and how the boundary with core is drawn. It does **not** fix #135 directly — it provides the conceptual model that turns #135 into a near-mechanical cleanup.

## 2. Goals

1. Define "plugin" precisely enough that we can cleanly split core from plugin code.
2. Define the core/plugin boundary so the next "where does this belong" question has a principled answer instead of a judgment call.
3. Define how plugins are authored, distributed, installed, and loaded — enough to support both Keepur-authored and community-authored plugins.
4. Define a composition model that lets the beekeeper pick what runs on each Hive instance.
5. Define agent onboarding in a way that's portable across hives with different installed plugins.
6. Resolve #135 as a direct consequence of applying the model to the current codebase.

## 3. Non-Goals

- **Skills as a first-class concept** — parked as #137. Skills are load-bearing but large enough to need their own design session. The plugin manifest in this spec reserves a `skills` field but leaves its semantics to the skills spec.
- **Native task system** — parked as #138. Linear is integration-core stopgap until that lands. The plugin architecture does not depend on native tasks shipping first.
- **Vault / Honeypot secrets channel** — parked as #139. Plugin config uses the existing env-var passthrough for the next 3 months. The spec deliberately avoids building a throwaway admin-UI-for-config layer that Honeypot will replace.
- **Physical extraction of `plugins/dodi/`** — that is the output of the #135 implementation plan, written after this spec is locked.
- **Plugin marketplace, ratings, discovery UX** beyond a simple registry file.
- **Plugin dependency resolution between plugins.** Plugins are flat — no plugin depends on another plugin. If a plugin needs a capability, it ships the MCP server itself or declares a required capability and the beekeeper resolves it.

## 4. Principles

Three principles govern every design decision in this spec. When a future question arises, it should be answered by reference to these first.

### 4.1 Hive is opinionated

Curation is part of the product. We ship a stack we believe in. Plugins are the mechanism for *alternatives to our opinions* and for *specialized extensions* — not the mechanism for "anything outside the core loop." When every hive we ship would install plugin X on day one, X should have been core.

### 4.2 Core = what we own or want to own. Plugin = what we intentionally delegate.

This is the rule for where any piece of functionality lives. Two sub-cases of core:

- **Native core** — code we write, data we store, processes we run on our box. Memory, tasks, schedule, event-bus, dispatcher, the agent fabric. These are eligible for real engineering investment because we control them end-to-end.
- **Integration core** — third-party systems we ship as the default integration and never plan to replace. Google Workspace, Slack (as the provider behind the slack adapter), Quo (as the SMS provider), macOS Keychain. We will never build our own Gmail. The wrapper is core; the system is someone else's.

Plugins are for:
- **Alternatives** to integration-core defaults (ms-365 instead of Google, Twilio instead of Quo, Postmark instead of Resend)
- **Specialized capabilities** that only some hives need (recall.ai for meeting bots, jira for ticketing at companies that don't use Linear)
- **Private extensions** for specific customers (dodi-ops wrapping the dodi_v2 proprietary system)

### 4.3 Plugins are system-scoped, not business-scoped

A plugin wraps **one external system** and ships everything whose existence presupposes that system: the MCP servers that talk to it, the skills that encode idiomatic use of those servers, and any utilities that understand the system's data shape. A plugin does **not** contain agent seeds, business logic, or cross-system orchestration. Those are composition-level concerns the beekeeper handles when standing up a hive.

This principle is the reason there is no `plugin:dodi` or `plugin:keepur`. Those were business bundles, not system wrappers. Under this principle, dodi's current `plugins/dodi/` splits into `hive-plugin-dodi-ops` (wraps the dodi_v2 ops system), `hive-plugin-hubspot` (wraps HubSpot), and agent seeds that live outside any plugin.

## 5. Plugin Definition

### 5.1 Contents

A plugin is a directory containing:

```
hive-plugin-<name>/
├── plugin.yaml          # Manifest (required)
├── mcp-servers/         # MCP server source (if any)
│   └── <server-name>/
├── skills/              # Skills (contract defined in #137 — for now, reserved)
├── dist/                # Built artifacts (generated)
├── package.json         # Build tooling
├── tsconfig.json
└── README.md
```

### 5.2 Manifest shape

```yaml
name: hive-plugin-hubspot
description: HubSpot CRM integration — live per-record CRUD + semantic RAG search
version: 0.1.0
hiveApi: "^1.0.0"         # compatibility declaration; hive refuses incompatible plugins

capabilities:
  - crm
  - crm-search

mcp-servers:
  hubspot-crm:
    entry: mcp-servers/hubspot-crm/index.js
    description: "Search and manage CRM — deals, contacts, companies, notes, tasks, activities"
    usage: "Reading/writing individual CRM records by ID or specific criteria"
    not-for: "Broad topic searches across deals — use crm-search instead"
    env: [HUBSPOT_API_KEY]
  crm-search:
    entry: mcp-servers/crm-search/index.js
    description: "Semantic search across CRM deals by topic or keyword"
    usage: "Broad discovery queries across deals and contacts"
    not-for: "Reading/writing specific records — use hubspot-crm for targeted CRUD"
    env: [OLLAMA_URL, QDRANT_URL, MONGODB_ATLAS_URI, VOYAGEAI_API_KEY]

skills: []                # Workflow dirs bundled in <pluginDir>/skills/ — see below
```

**Field contract:**

| Field | Type | Required | Purpose |
|-------|------|----------|---------|
| `name` | string | yes | Must start with `hive-plugin-` by convention; used as the plugin identifier everywhere. Note: `agent-runner.ts` resolves server paths from the on-disk *directory name*, not the manifest `name` — they should match, but transitional in-tree plugins (e.g. `plugins/dodi/` with `name: dodi`) are not load-bearing failures and can be corrected at extraction time. |
| `description` | string | yes | One-line human summary for the beekeeper |
| `version` | semver | yes | Plugin version, informational and used for upgrade checks |
| `hiveApi` | semver range | yes | Minimum compatible Hive core API version; hive refuses to load incompatible plugins |
| `capabilities` | string[] | yes | Free-tag list advertising what this plugin provides (e.g., `crm`, `ticketing`, `email-transactional`). Natural-language tags, no enum, no taxonomy committee. |
| `mcp-servers.<name>` | object | no | One entry per MCP server the plugin ships |
| `mcp-servers.<name>.entry` | path | yes (if server) | Path to the compiled JS entry point, relative to plugin root |
| `mcp-servers.<name>.description` | string | yes | What the server does (shown to agents in prompt) |
| `mcp-servers.<name>.usage` | string | no | "Use for…" guidance |
| `mcp-servers.<name>.not-for` | string | no | Common misuse — "for X, use Y instead" |
| `mcp-servers.<name>.env` | string[] | no | Env var names to forward from the base process |
| `mcp-servers.<name>.env-map` | Record<string,string> | no | Rename vars: `{TARGET: SOURCE}` — e.g. `DODI_OPS_API_URL: TASK_LEDGER_API_URL` |
| `mcp-servers.<name>.agent-env` | Record<string,string> | no | Pull values from the calling agent's config. Target supports dotted paths (e.g. `metadata.dodiOpsMode`) per §5.3 — note that dotted-path support is implemented as part of #135 (steps 4 and 5 land atomically); flat keys are the only thing that resolves before that lands. |
| `skills` | string[] | no | List of workflow directory names bundled in `<pluginDir>/skills/`. Each entry is a workflow dir following the standard two-level layout (`skills/<workflow>/skills/<skill>/SKILL.md`). The skill loader scans these at boot and merges them into the shared skill index. Customer-space skills at `<hiveHome>/skills/` shadow plugin-bundled skills on workflow-name collision — see `2026-04-15-skills-customer-space-design.md` for the ownership model and collision semantics. |
| `register-commands` | string | no | Path to JS module exporting `registerCommands(registry)` for team slash commands. The `registry` parameter is a `CommandRegistry` instance (class defined in `src/team/command-registry.ts`); the loader invokes the export at plugin load. Registration failures are logged as warnings and do not prevent the plugin from loading — a broken slash-command should not disable the rest of the plugin's MCP servers. |

**Capability tag discipline.** Tags are free-form (§9.3) but matching is a plain string intersection, so a plugin that advertises `crm-search` is *not* a match for an archetype that requires `crm`. When adding a plugin or an archetype, check that the tags line up with what already exists in the ecosystem. This is deliberately informal — future work may add LLM-assisted fuzzy matching if it proves annoying — but it's a footgun worth knowing about now.

### 5.3 The `metadata` escape hatch on agent definitions

The current `dodiOpsMode` field on `AgentDefinition` is the last typed plugin-specific leak in core. It is replaced by a generic field bag:

```typescript
interface AgentDefinition {
  // ...
  metadata?: Record<string, unknown>;
}
```

Plugins read from this bag via `agent-env` manifest mappings that support dotted paths (`metadata.dodiOpsMode`). Core never interprets the bag. This lets plugins stash per-agent configuration (access levels, mode flags, routing hints) without asking core to know about them.

**Resolver semantics.** When `agent-env` declares a value with dotted-path syntax, the agent runner walks the path left-to-right against the calling agent's `AgentConfig`. Any missing intermediate key yields the empty string `""` — there is no fallback to a top-level field of the same name, and no error is raised. A misconfigured key produces a server that runs with empty config (which the plugin should defensively handle), rather than silently masking the typo by hitting a different field. Flat keys (no dot) continue to resolve as today against top-level `AgentConfig` fields, for backward compatibility with existing manifests during the transition.

### 5.4 What a plugin is NOT

To keep the boundary sharp, a plugin must never contain:

- **Agent seeds.** Seeds are composition-level artifacts owned by the beekeeper (see §8.2). Plugins provide capabilities; they do not prescribe which agents a hive has.
- **Business logic.** A plugin wraps one external system. "How Keepur sells to local home-services businesses" is not a plugin — it's the composition of agent seeds, skills, and installed plugins on a particular hive.
- **Cross-system orchestration.** A skill that says "read from HubSpot, then write to dodi-ops" presupposes both systems and therefore belongs to neither plugin alone. Cross-system skills live at the composition level or inside whichever side the beekeeper chooses as "home," but not inside a plugin's manifest.
- **Workflow definitions.** The workflow engine is core. Plugins provide tools the workflow engine can orchestrate; they don't ship workflow templates of their own.
- **Core primitives.** Memory, tasks, schedule, event-bus, callback, background, team messaging — these are core by definition (§4.2). A plugin that reimplements any of them is doing something wrong.

If a future plugin candidate doesn't fit this shape, it is probably not a plugin. Revisit whether it belongs in core (§4.2 rule) or whether it belongs at composition level (§8).

## 6. Core / Plugin Split (Current Codebase)

Applying the principles in §4 to every subsystem currently in `src/`:

### 6.1 Native core

- **Agent fabric:** dispatcher, agent-runner, agent-manager, agent-registry, session-store, model-router
- **Bootstrap:** config, logging, plugin loader, admin API
- **Memory primitives:** memory, structured-memory
- **Coordination primitives:** event-bus, callback, background, schedule, team, contacts, admin
- **Conversation & code:** conversation-search, code-search, code-task
- **Tasks:** `task-mcp-server` — currently coupled to `dodi_v2`, rewrite tracked in #138. Stays core.
- **Channel plumbing:** slack-adapter, sms-adapter, ws-adapter (the code that turns inbound messages into WorkItems and routes WorkItems to outbound — not the provider SDKs)
- **Workflow engine, scheduler**

### 6.2 Integration core

Third-party systems we ship as defaults and never plan to replace:

- **Google Workspace** — Gmail, Calendar, Drive, per-agent accounts. Primary conversational outbound for every agent.
- **Slack** — via the Slack HTTP MCP server, as the provider behind the core slack adapter
- **Quo / OpenPhone** — as the provider behind the core SMS adapter
- **macOS Keychain** — OS primitive; security story
- **Linear** — **stopgap**, demoted to plugin once #138 ships

### 6.3 Plugins

- **`hive-plugin-dodi-ops`** (private to Keepur-hosted dodi-hive): `dodi-ops`, `catalog`, `ops-search`, `product-search`, `permits`. Wraps the dodi_v2 proprietary system and its adjacent permit monitoring.
- **`hive-plugin-hubspot`** (private for now, potentially community later): `hubspot-crm`, `crm-search`. Live query + RAG search over the same HubSpot deals.
- **`hive-plugin-recall`** — meeting bot integration. Specialized, not universal.
- **`hive-plugin-clickup`** — alternative ticketing.
- **`hive-plugin-github-issues`** — alternative ticketing. Will graduate from core once Linear does.
- **`hive-plugin-resend`** — transactional email. Narrow use case. Demoted from current core because agents do *conversational* email via Gmail; transactional is a separate, optional capability.
- **Future alternatives:** `hive-plugin-microsoft-365`, `hive-plugin-twilio`, `hive-plugin-postmark`, `hive-plugin-jira`, etc.

### 6.4 What changes from today

| Subsystem | Today | Target |
|-----------|-------|--------|
| `config.hubspot` block | In core `config.ts` | Deleted. Plugin's MCP servers read `process.env.HUBSPOT_API_KEY` directly. |
| `config.resend.hubspotBcc` | In core `config.ts` | Renamed end-to-end: the `config.ts` field becomes `resend.defaultBcc`, the env var read becomes `RESEND_DEFAULT_BCC` (with `HUBSPOT_BCC_OUTGOING` honored as a fallback for deploy continuity), and the env key passed to the resend MCP server at spawn time in `agent-runner.ts` becomes `RESEND_DEFAULT_BCC`. All three sites must change together — leaving any of them as `HUBSPOT_BCC*` defeats the bundle decontamination. Resend itself becomes a plugin in a follow-on round. |
| `dodiOpsMode` on AgentDefinition | Typed core field | Replaced by `metadata: Record<string, unknown>`. Plugin reads via `agent-env: DODI_OPS_MODE: metadata.dodiOpsMode`. |
| `SERVER_CATALOG` entries for hubspot-crm, dodi-ops, catalog, permits, crm-search, product-search, ops-search | Hardcoded in `src/tools/server-catalog.ts` | Deleted. Plugin manifest fallback in `agent-runner.getServerCatalogEntry` renders the same text from plugin YAML. |
| `SERVER_CREDENTIAL_CHECKS` for hubspot/dodi/permits/catalog/product-search/ops-search | Hardcoded in `src/tools/instance-capabilities.ts` | Deleted. Plugin servers are considered "configured" when every env var named in their manifest `env:` list is non-empty in `process.env`. Core iterates installed plugins and runs this check generically — no plugin-specific knowledge in core. |
| `integrations` block in `InstanceCapabilities` (`crm`, `email`, `sms`, `browser` flags derived from `config.hubspot?.apiKey` etc.) | Hardcoded against core config fields | Removed in #135. The generic `servers.configured` / `servers.unconfigured` arrays produced by the new credential check are the only capability surface; admin/beekeeper displays read from those arrays. We do not rebuild a typed integrations map — adding one would re-create the same plugin-specific knowledge the spec is removing. |
| `task-mcp-server` comments about `dodi_v2` | In core | Sanitized to generic language. Full rewrite tracked in #138. |
| `plugins/dodi/` in hive repo | In-tree | Extracted to two private git repos (`hive-plugin-dodi-ops`, `hive-plugin-hubspot`). Hive core ships zero plugins. |
| Dodi agent seeds (9 templates) | In `plugins/dodi/agent-seeds/` | Discarded. Only `software-engineer` survives as a canonical archetype example. Live agent definitions already exist in dodi-hive's Mongo and don't need a source-of-truth file. |
| Default instance id `"dodi"` in `setup/setup-instance.ts` | `"dodi"` | `"hive"` |

## 7. Distribution and Installation

### 7.1 Plugins live outside the core repo

The core `@keepur/hive` npm tarball ships **zero plugins**. No `plugins/` directory in `files:` whitelist. Core is plugin-agnostic at the bits level.

Each plugin is its own git repository, versioned independently.

### 7.2 `hive plugin add <source>` — registry is the paved path

**Hive's security posture treats runnable content as employees, not drop-ins.** A plugin ships an MCP server, and the MCP server is the legitimate credential holder under the Honeypot + Keychain model (§10, #139). A malicious plugin can exfil secrets directly — architecture alone cannot stop it. The only meaningful defense is gating which plugins are allowed to run in the first place, and registries are the trust boundary. For that reason, plugin installation is **registry-first by design**, with raw-URL install as a clearly-marked developer-mode escape hatch.

The CLI supports three installation paths:

1. **Registry short name (paved path)** — `hive plugin add hubspot` looks up `hubspot` in a JSON registry file the beekeeper has configured and trusts. The default registry is Keepur-hosted (`plugins.keepur.dev/registry.json`); third parties can host their own registries and the beekeeper can add them via `hive registry add <url>`; local-file registries are also supported for on-premise curation. The beekeeper's trust relationship is with the *registry curator*, not with individual plugin authors. If you trust Keepur, you trust the plugins Keepur lists. If you trust another curator, you can add their registry to your trust set.

2. **Local path (dev mode)** — `hive plugin add ./plugins/dodi-ops` installs from a local directory for development on first-party plugins without publishing. Intended for plugin authors actively building, not for beekeepers deploying. Symlinked or copied, TBD at implementation time.

3. **Raw git URL (developer escape hatch, not the paved path)** — `hive plugin add --dev-mode github.com/someone/hive-plugin-foo` clones the repo, builds it, and installs it. **Requires an explicit `--dev-mode` flag.** The CLI prints a security warning before proceeding: "You are installing a plugin from an uncurated source. This plugin will have the same credential access as any other plugin. Do not use in production." In production hive deployments, this path should be disabled via instance config — `hive.yaml` adds a top-level `plugins.allowRawUrl` boolean (default `true` in dev, recommended `false` in production deploys; when `false`, the CLI exits non-zero before clone). It exists so plugin authors can test unpublished work and so the dev loop isn't artificially blocked on registry publication — not so random GitHub plugins flow into production hives.

**How a beekeeper gets a plugin they found on the internet.** The workflow is not "paste the URL into `hive plugin add`." It is: read the plugin source, verify it looks safe, either (a) submit it to the Keepur registry for public curation, (b) add it to a locally-maintained registry file, or (c) fork it into a repo the beekeeper controls and add that to their registry. All three routes end at the same gate — a curated registry the beekeeper has chosen to trust — and none of them involve pasting URLs into production hives on first sight.

This is a philosophical shift from "distribution is open, trust is user-judged" to "distribution is curated by default." It's worth the friction because the alternative is a single malicious plugin becoming game-over for a customer hive.

### 7.3 Installation layout

Installed plugins live under a per-instance `plugins/` directory, using the standard Node `node_modules` layout that `npm install --prefix` produces:

```
<instance-dir>/plugins/node_modules/<package-name>/
```

For example, `~/services/hive/plugins/node_modules/@keepur/hive-plugin-hubspot/`. Per-instance, not shared across instances on the same machine. Not in the hive core repo. The beekeeper can `ls plugins/node_modules/` and see exactly what's installed on this hive.

This matches the path `src/agents/agent-runner.ts` already resolves at runtime (`<hiveHome>/plugins/node_modules/<package>/dist/mcp/...`). For local in-tree development, plugins under `<repo>/plugins/<name>/` are still discovered via the existing dev path resolution; the layouts coexist during the transitional period (in-tree dodi ↔ npm-installed third-party plugins).

**Source of truth.** The long-term model is a Mongo composition record (§8.1) that's authoritative for *which plugins this hive runs*; the filesystem is where the code lives so it can be loaded. **In the #135 timeframe**, the source of truth is still the `plugins:` array in `hive.yaml` (read by `loadPlugins(appConfig.plugins, ...)` in `agent-manager.ts`). The composition record is follow-on infrastructure — see §11 "Explicit non-scope" and §8.1. The reconciliation rules described below apply to both source-of-truth modes.

Reconciliation rules: if a directory exists on disk that isn't in the composition (or `hive.yaml`), it's ignored with a warning in the log — orphan directories do not auto-register. If the source of truth lists a plugin whose directory is missing, the plugin is skipped with a clear error and boot continues. This split keeps declarative configuration separate from the mutable cache the installer writes to.

### 7.4 Compatibility check

On load, the plugin loader reads `hiveApi` from the manifest and compares against the running hive's API version (exposed as a constant in core). Mismatch → plugin is logged as incompatible and skipped; hive still boots. The `hiveApi` version is bumped when core changes break the plugin contract (manifest schema changes, agent-runner env-resolution changes, etc.).

**Initial value.** The starting `hiveApi` version is `1.0.0`, which will be exposed as `HIVE_PLUGIN_API_VERSION` from `src/plugins/api-version.ts` (added as part of #135's loader work). Plugin manifests should declare `hiveApi: "^1.0.0"` until a breaking core change forces a major bump. The dotted-path resolver added in §5.3 is part of the 1.0.0 contract — plugins that rely on it can declare `hiveApi: "^1.0.0"` without further qualification.

### 7.5 Upgrade and removal

- `hive plugin upgrade <name>` — re-fetches the latest from the source URL recorded at install time, rebuilds, validates, hot-swaps via SIGUSR1 reload.
- `hive plugin remove <name>` — removes from the instance plugin directory and from the composition record.

These are straightforward wrappers around the install primitive. Implementation is not load-bearing for this spec; they're listed for completeness.

## 8. Hive Composition

### 8.1 Composition as mutable DB record

Each hive instance has a composition record in MongoDB. The beekeeper edits it over time. At boot, hive loads:

1. The non-negotiable core set (hardcoded in core — there is no "core manifest" because core is not configurable).
2. The composition record, which lists:
   - `plugins`: installed plugin names (matching directory names in `<instance-dir>/plugins/`)
   - `agentSeeds`: seeds the beekeeper has chosen to provision, referenced by name (see §8.2)
   - `skills`: standalone skills installed (semantics per #137)

There is no named bundle. No `plugin:dodi` aggregate. The composition *is* the aggregate, and it's editable.

### 8.2 Agent seeds are not plugins

Agent seeds are composition-level artifacts. They describe a starting-point agent profile (identity, model, channels, coreServers, delegateServers, systemPrompt, metadata, etc). They reference plugins and capabilities but are not shipped inside them.

The canonical storage for agent seeds in the new model is **MongoDB directly** — seeded once at hive setup, then managed via admin MCP tools and REST API from then on. Files on disk are optional convenience for authoring, not the source of truth.

One agent seed ships with hive core itself as a canonical example: **`software-engineer`**, which is the concrete realization of the software-engineer archetype (#137 will cover archetype internals). All other existing dodi seeds (vp-engineering, customer-success, sdr, etc.) are discarded from source control — their runtime definitions already live in dodi-hive's Mongo.

### 8.3 Schema (sketch)

```typescript
interface HiveComposition {
  instanceId: string;
  plugins: Array<{
    name: string;              // "hive-plugin-hubspot"
    source: string;            // git URL or local path used at install
    version: string;           // from manifest at install time
    installedAt: Date;
  }>;
  agentSeeds: string[];        // names seeded into this instance
  skills: string[];            // reserved for #137
  updatedAt: Date;
  updatedBy: string;
}
```

Stored in `hive_composition` collection. Read at boot, updated on `hive plugin add/remove/upgrade` and on admin-driven agent seed changes.

## 9. Agent Onboarding

### 9.1 Two paths, one output

**Archetype-driven** — the beekeeper picks an archetype (`software-engineer`, `executive-assistant`, etc). The archetype declares a minimum capability kit: `requires: [ticketing, code-search]`. The onboarding flow matches those requirements against installed plugins' `capabilities` tags. If the hive has no plugin providing `ticketing`, creation is blocked with a clear error: the admin MCP `agent_create` tool returns a structured error with the missing capability and a suggested install command, and the `hive agent create` CLI exits non-zero printing the same hint ("install a ticketing plugin first, e.g. `hive plugin add linear`"). If multiple plugins provide `ticketing`, the flow either picks the first or prompts the beekeeper.

**Purely composite** — the beekeeper creates an agent from a blank slate, hand-picks tools, writes the system prompt, and the result is whatever they composed. No minimum enforcement. No archetype label.

Both paths produce the same `AgentDefinition` document. Archetype creation sets an `archetype` field for metadata, composite creation leaves it unset.

### 9.2 Creation-time gate, not live invariant

Archetype minimums are enforced **only at agent creation**. After creation, the agent's toolset is editable freely — the beekeeper can strip tools, change channels, rewrite prompts. The archetype label does not enforce anything at runtime; it's a historical marker of how the agent was born. Agents grow into roles and out of them; titles are loose.

Rationale: a live invariant would fight organic agent evolution and would have to be ripped out. Creation-time gates catch the most common mistake (creating a crippled version of a well-known role) without getting in the way of growth.

### 9.3 Capability matching uses free tags

Capabilities are a plain list of lowercase string tags. No enum, no registry, no central taxonomy. Examples: `crm`, `ticketing`, `crm-search`, `email-transactional`, `code-search`, `meeting-bot`, `permit-monitoring`.

Matching is a string intersection. When archetypes and plugins use slightly different tags for overlapping concepts, the beekeeper edits the plugin manifest or the archetype definition until they agree. LLMs can help fuzz the matching at plugin install time if it proves annoying — future work, not in scope.

## 10. Config & Secrets Boundary

This is deliberately the thinnest section of the spec because the long-term home for plugin config is #139 (Vault / Honeypot).

### 10.1 Interim model (next 3 months)

- Plugins declare their env var names in `plugin.yaml` under `mcp-servers.<name>.env`.
- Agent runner forwards matching env vars from `process.env` to the plugin's MCP server subprocess at spawn time.
- Plugin MCP servers read directly from `process.env.FOO`. This already works for `hubspot-crm-mcp-server.ts` today.
- Beekeeper sets values via the instance `.env` file, same as today. No admin UI for plugin config.
- Core `config.ts` holds zero plugin-specific fields. No `config.hubspot`, no `config.dodiOps`, no `config.resend.hubspotBcc`.

### 10.2 Why not more

The Vault / Honeypot concept (#139) will replace this entire layer with an out-of-band secure channel terminated at macOS Keychain. Agents never see secrets in environment variables under the target model — they request them from a special local-model-backed agent that writes Keychain. Building a structured admin UI for plugin config now would be throwaway work the day Honeypot ships.

The interim model is "just enough to unblock #135 and first-customer install." No more.

### 10.3 Dependency note

If Honeypot slips significantly or changes shape, this section should be revisited. The rest of the plugin architecture does not depend on Honeypot — the interim env-var passthrough works indefinitely if it has to.

## 11. Impact on #135

The #135 implementation plan, written after this spec is locked, is a mechanical application of this design to the current codebase. Summary of the fix:

1. Delete plugin-specific entries from `src/tools/server-catalog.ts` (hubspot-crm, dodi-ops, catalog, permits, crm-search, product-search, ops-search).
2. Delete plugin-specific credential checks from `src/tools/instance-capabilities.ts`.
3. Delete `config.hubspot` block from `src/config.ts`. Rename `resend.hubspotBcc` → `resend.defaultBcc` end-to-end (config field, env var read with `HUBSPOT_BCC_OUTGOING` fallback, env key passed at `agent-runner.ts` server-spawn site). See §6.4 row for the three sites.
4. Replace `dodiOpsMode` field on `AgentDefinition` / `AgentConfig` with `metadata: Record<string, unknown>`.
5. Extend agent runner's `agent-env` resolver to support dotted paths (`metadata.dodiOpsMode`) per §5.3 resolver semantics. **Steps 4 and 5 must land atomically in the same PR** — without the dotted-path resolver, removing `dodiOpsMode` from `AgentConfig` would silently make the existing `DODI_OPS_MODE: dodiOpsMode` flat lookup return `""` and break dodi-hive at runtime. Update `src/agents/agent-runner.test.ts` (currently asserts the flat-field path at line ~353) in the same step.
6. Update `plugins/dodi/plugin.yaml` to carry `usage` / `not-for` for every server and change `agent-env` to use dotted paths.
7. Update dodi agent seeds that reference `dodiOpsMode` to use `metadata.dodiOpsMode`.
8. Sanitize `dodi_v2` comments in `src/tasks/task-ledger.ts` and `src/tasks/task-mcp-server.ts`.
9. Change default instance id `"dodi"` → `"hive"` in `setup/setup-instance.ts`.
10. Add CI guardrail: `scripts/check-bundle-strings.mjs` fails if `pkg/*.min.js` contains any of `dodi`, `hubspot`, `cabinet`.

Physical extraction of `plugins/dodi/` out of the hive repo into separate git repos is explicit follow-up work, not part of #135 itself. #135 ships when the core tarball is clean *and* the in-tree dodi plugin still works for our deploy.

**Explicit non-scope for #135:**
- Linear extraction to a plugin. Linear remains integration-core until #138 (native tasks) ships, at which point it gets extracted in a separate PR.
- Resend extraction to a plugin. Resend demotion to a plugin is an eventual cleanup, not part of this fix. The #135 plan only renames `HUBSPOT_BCC` → `RESEND_DEFAULT_BCC` and removes the `config.hubspot` block; the resend MCP server itself stays in `src/` for this round.
- Google, Slack, Quo, Keychain — all remain integration-core per §6.2.
- **`hive_composition` MongoDB collection.** §8 describes the target source-of-truth model, but #135 ships with `hive.yaml`'s `plugins:` array still acting as the plugin list (read by `loadPlugins(appConfig.plugins, ...)` in `agent-manager.ts`). Migration from `config.plugins` to `hive_composition` is follow-on work scheduled with the physical plugin extraction. The §7.3 reconciliation rules apply to either source-of-truth mode.
- **Removing `agent-seeds` from `plugin.yaml` and `agentSeeds` from `PluginManifest`.** §5.4 prohibits seeds inside plugins under the target model, but during the #135 transitional window `plugins/dodi/plugin.yaml` still lists its 9 seeds and `src/plugins/plugin-loader.ts` still validates those paths. Both go away when `plugins/dodi/` physically extracts. Until then, the loader's seed-validation path stays — touching it now is wasted churn.

## 12. Open Questions Deferred to Follow-On Specs

- **Skills contract (#137)**: now specified in `2026-04-14-skills-system-design.md`. Plugin-bundled skills live in `<pluginDir>/skills/`; customer-owned skills (agent-authored and registry-installed) live in `<hiveHome>/skills/` per `2026-04-15-skills-customer-space-design.md`. Registry distribution is covered by `2026-04-15-skills-registry-design.md`.
- **Native task system (#138)**: schema, FSM, Mongo collection layout, migration from current Linear usage.
- **Vault / Honeypot (#139)**: transport, local-model termination, Keychain placement, plugin consumption API.
- **Plugin hot reload semantics**: today SIGUSR1 reloads agent definitions. Does `hive plugin upgrade` need a separate signal, or is SIGUSR1 enough? Minor implementation detail, not architectural.

## 13. Acceptance Criteria

This spec is done when:

1. The core/plugin boundary is defined clearly enough that a future "where does X belong" question can be answered from §4 alone without re-litigation.
2. A new plugin can be authored, installed, and loaded without touching any file in the hive core repo.
3. The plugin manifest covers every extension point the current `plugins/dodi/` uses, with no ad-hoc core code required.
4. `#135` can be implemented mechanically from §11 without further design work.
5. Skills (#137) and native tasks (#138) can be designed later without invalidating anything in this spec.
