# Hive MVP Readiness Epic

**Date**: 2026-04-15
**Status**: Draft
**Goal**: A CEO can receive an email with a link, run `npm i -g @keepur/hive && hive init`, and be talking to a Chief of Staff agent in Slack within 20 minutes. No source code visible. No hand-holding. Can't fuck up.

## Audience

Technical CEOs and independent business managers. They've been in the business, have great connections, and word travels fast in their circles. They want to try Hive both as a personal team and for company deployment. They are not testers — this is a trust gate. First impressions are permanent.

## Day-One Experience

```
Email with link + short guide
  → npm i -g @keepur/hive        # closed-source minified package
  → hive init                     # prereqs, Anthropic key, Slack app, config
  → CoS appears in Slack          # "Hi, I'm your Chief of Staff. Let's get set up."
  → Onboarding conversation       # who are you, what do you do, what's your business
  → Capability inventory           # "Here's what I can do out of the box, and here's
                                   #  what's available from the registry"
  → Google OAuth walkthrough       # CoS guides them through credential setup
  → Team building                  # "What agents do you need? Let me set them up."
  → Plugin/skill install           # CoS recommends and installs via registry
```

## Track Overview

| # | Track | Status | Blocks MVP? |
|---|-------|--------|-------------|
| 1 | Core npm package + build pipeline | **Scaffolded** (cli.ts, bundle.ts exist) | Yes |
| 2 | `hive init` wizard (end-to-end) | **Partial** (setup-instance.ts exists, needs integration) | Yes |
| 3 | Prereqs installer | **Partial** (missing Ollama, Qdrant, models, Xcode CLI) | Yes |
| 4 | Chief of Staff ships with core | **Not started** (core currently ships zero seeds) | Yes |
| 5 | Agent runner path resolution | **Not started** (still resolves from cwd) | Yes |
| 6 | Plugin architecture implementation | **Spec locked** (#135 decontamination done) | Yes |
| 7 | Skills registry operational | **Spec locked** | Yes — CoS needs skills |
| 8 | Default plugin registry content | **Not started** | Yes |
| 9 | Config resolution (HIVE_HOME) | **Scaffolded** (cli.ts has HIVE_HOME) | Yes |
| 10 | Credential bootstrapping flow | **Not started** | Yes |
| 11 | `hive doctor` | **Scaffolded** (CLI wired, impl TBD) | Yes |
| 12 | `hive update` | **Scaffolded** (CLI wired, impl TBD) | Should-have |
| 13 | `hive start --daemon` (LaunchAgent) | **Scaffolded** (CLI wired, impl TBD) | Should-have |
| 14 | Monitoring / health signal | **Not started** | Should-have |
| 15 | Agent builder skill | **Spec ready** | Should-have (CoS can create agents via admin tools as fallback) |
| 16 | Customer-facing docs + install guide | **Not started** | Yes |
| 17 | npm publish pipeline | **Not started** (manual is fine for now) | Yes |
| 18 | License decision | **Not made** | Yes |
| 19 | Versioning strategy | **Not decided** | Yes |
| 20 | Appliance (Mac Mini, Vault, 3-user) | Spec exists (vision) | **No — post-MVP** |

---

## Track Details

### Track 1: Core npm Package + Build Pipeline

**What exists**: `src/cli.ts` (118 lines, full command routing), `build/bundle.ts` (esbuild config, 23 MCP server entry points, externals list). Both landed in #109.

**What's missing**:
- [ ] Validate the bundle actually runs on a clean machine (not just builds)
- [ ] `package.json` changes: remove `"private": true`, add `name: "@keepur/hive"`, `bin`, `files` whitelist, `engines`
- [ ] `npm pack --dry-run` audit — verify only `pkg/`, `seeds/`, `templates/` ship
- [ ] Setup wizard bundle entry point (TODO in bundle.ts line 59)
- [ ] The `files` whitelist must include the CoS seed (Track 4) — but nothing from `plugins/` or `src/`
- [ ] Shebang on cli.min.js (currently builds without — the `banner` config exists but verify post-minify)

**Depends on**: Nothing. Can start immediately.

### Track 2: `hive init` Wizard (End-to-End)

**What exists**: `setup/setup-instance.ts` — interactive wizard that handles instance ID, type, port scanning, writes `hive.yaml`. `setup/install-prereqs.sh` — installs Homebrew, Node, MongoDB, Git.

**What's missing — the gap is integration**:
- [ ] `hive init` must be a single flow: prereqs → Anthropic key → Slack app → Google OAuth (optional) → instance config → `.env` generation → seed CoS → start service → verify CoS responds
- [ ] Currently `setup-instance.ts` resolves `HIVE_CONFIG` relative to cwd. Needs to write to `~/.hive/` when running from global install.
- [ ] The wizard's "next steps" output (line 205-212) lists manual steps. These must become automated steps in the flow.
- [ ] `execSync` calls in prereqs script must be audited for DOD-212 compliance (the bash script itself is fine — it's not a Node `execSync` issue — but any TypeScript wrappers that shell out need `execFileSync`)
- [ ] Slack app creation UX: the wizard should open the Slack manifest URL, guide the user through install, prompt for tokens, validate they work before continuing
- [ ] `.env` template generation with prompted values (ANTHROPIC_API_KEY, SLACK_APP_TOKEN, SLACK_BOT_TOKEN, at minimum)
- [ ] Write `~/.hive/hive.yaml` and `~/.hive/.env`
- [ ] Initial MongoDB setup: create database, seed CoS agent definition
- [ ] Generate LaunchAgent plist (existing `generate-plist.ts` can be adapted)

**Depends on**: Track 3 (prereqs), Track 4 (CoS seed), Track 9 (HIVE_HOME config resolution)

### Track 3: Prereqs Installer

**What exists**: `setup/install-prereqs.sh` handles Homebrew, Node 22, MongoDB, Git.

**What's missing**:
- [ ] Xcode Command Line Tools (`xcode-select --install`) — needed for `better-sqlite3` native compilation
- [ ] Ollama (`brew install ollama` + `brew services start ollama`)
- [ ] Ollama models (`ollama pull bge-large`, `ollama pull qwen2.5:3b`)
- [ ] Qdrant (`brew install qdrant` + `brew services start qdrant`)
- [ ] `gh` CLI (optional, for GitHub Issues MCP)
- [ ] Required vs optional distinction: Homebrew/Node/MongoDB/Ollama/Qdrant/models are required. gh is optional.
- [ ] Progress reporting — these installs take time, the user needs to see what's happening
- [ ] Idempotency — safe to re-run if interrupted

**Depends on**: Nothing. Can start immediately.

### Track 4: Chief of Staff Ships with Core

**Current state**: Core ships zero agent seeds. The "core ships nothing" principle was established for plugins and skills, but CoS is different — it IS the product's front door.

**Decision needed**: CoS must ship with core. This is a reversal of the "zero seeds" direction for this one agent.

**What's needed**:
- [ ] CoS agent seed: `seeds/chief-of-staff/agent.yaml` + `seeds/chief-of-staff/system-prompt.md`
- [ ] CoS soul: onboarding-focused personality that interviews new users, inventories capabilities, guides credential setup, recommends team structure
- [ ] CoS must know about the plugin/skills registry — it needs to tell users what's available
- [ ] `hive init` seeds CoS into MongoDB as the final setup step
- [ ] CoS needs access to: memory, admin (to create agents), Google (post-OAuth), schedule, team (to introduce new agents)
- [ ] Onboarding skill: structured conversation flow that the CoS executes on first contact with a new user

**Depends on**: Track 6 (plugin architecture — CoS needs to know what plugins exist), Track 7 (skills registry — CoS needs to install skills)

### Track 5: Agent Runner Path Resolution

**Current state**: `src/agents/agent-runner.ts` resolves all ~23 MCP server paths via `resolve("dist/...")` relative to `process.cwd()`. Works in dev. Breaks in global npm install where cwd is `~/.hive/`.

**What's needed**:
- [ ] Systematic refactor: all built-in MCP server paths resolve from `import.meta.dirname` (the package's own directory)
- [ ] Plugin MCP server paths resolve from `~/.hive/plugins/<name>/dist/mcp/`
- [ ] Third-party npm servers (brave-search-mcp) use `createRequire` to resolve from package's own `node_modules`
- [ ] Test: bundle the package, install globally, verify all 23 MCP servers spawn correctly

**Depends on**: Track 1 (bundle pipeline must work first to test against)

### Track 6: Plugin Architecture Implementation

**Spec**: `2026-04-14-plugin-architecture-design.md` (locked)
**Prereq**: #135 core decontamination (done in #142)

**What's needed**:
- [ ] Plugin loader: reads `plugin.yaml` manifests from `~/.hive/plugins/`
- [ ] Registry fetch: `hive plugin add <name>` resolves against registry, clones, validates `hiveApi` compat
- [ ] Plugin MCP server registration in agent runner
- [ ] `hive plugin list` / `hive plugin remove`
- [ ] Default Keepur plugin registry (Track 8)
- [ ] `hiveApi` version field in core `package.json`

**Depends on**: Track 8 (there must be something in the registry to install)

### Track 7: Skills Registry Operational

**Spec**: `2026-04-15-skills-registry-design.md` (locked)

**What's needed**:
- [ ] `hive skill add/list/upgrade/remove` CLI implementation
- [ ] Registry fetch layer (git clone from registry URL)
- [ ] Multi-registry config in `hive.yaml`
- [ ] Default Keepur skills registry (`github.com/keepur/hive-skills`) — must exist and have content
- [ ] Customer-space write guard (skills-customer-space spec)
- [ ] Instance-local git `state` branch for audit history

**Depends on**: Skills customer-space spec implementation (KPR-29 scope)

### Track 8: Default Plugin Registry Content

**What's needed**: A real registry with real plugins that a customer can install on day one.

**Open questions**:
- [ ] Where does the registry live? `github.com/keepur/hive-plugins`?
- [ ] What plugins ship at launch? Candidates:
  - `google` — Gmail + Calendar + Drive (via `gog` CLI). **Must-have for CoS.**
  - `dodi` — CRM, ops, catalog, permits. Only relevant for dodi customers — skip for generic MVP?
  - `hubspot` — CRM. Relevant for many CEOs.
  - `linear` — Issue tracking. Dev-focused, maybe not day-one.
  - `github-issues` — Same.
- [ ] Plugin extraction: these are currently built-in MCP servers in core. Each one that becomes a plugin needs to be extracted into its own package with `plugin.yaml`, its own build, its own entry in the registry.
- [ ] **Minimum viable registry**: Google plugin + a "starter pack" (memory, contacts, schedule — but these are core, not plugins). Needs scoping.

**This is the hardest track.** It's not code — it's content, packaging, and decisions about what's core vs. plugin.

### Track 9: Config Resolution (HIVE_HOME)

**What exists**: `cli.ts` already sets `HIVE_HOME` from `--config` flag. `src/config.ts` loads from cwd.

**What's needed**:
- [ ] Config resolution order: `HIVE_HOME` env → `./hive.yaml` in cwd → `~/.hive/`
- [ ] `HIVE_CONFIG` coexistence for multi-instance (existing deploys)
- [ ] `.env` loading respects `HIVE_HOME` (currently loads from cwd)
- [ ] All internal paths that assume cwd === project root must be audited

**Depends on**: Nothing. Can start immediately.

### Track 10: Credential Bootstrapping Flow

**Mechanism**: `scripts/honeypot` — macOS Keychain wrapper, stores credentials under `hive/<instance-id>/<KEY>`. The keychain MCP server (`keychain-mcp-server.ts`) already reads these at runtime. Coexists with `.env` for existing deploys.

**What exists**: `scripts/honeypot` with `set`, `get`, `list`, `rm`, `doctor` commands. Instance-scoped via `hive.yaml` resolution. `honeypot doctor` validates required keys (ANTHROPIC_API_KEY, SLACK_APP_TOKEN, SLACK_BOT_TOKEN).

**What's needed**:
- [ ] **`hive init` integration**: wizard prompts for Anthropic key → `honeypot set ANTHROPIC_API_KEY`
- [ ] **Slack tokens**: wizard opens manifest URL, guides app creation, prompts for tokens → `honeypot set SLACK_APP_TOKEN` / `SLACK_BOT_TOKEN`, validates connection before continuing
- [ ] **Google OAuth**: CoS walks user through post-init. Guides user to run `honeypot set` for OAuth tokens. This is the hardest credential UX but the mechanism is solved.
- [ ] **Per-plugin credentials**: when CoS installs a plugin that needs credentials (HubSpot API key, etc.), it tells the user to run `honeypot set <KEY>` from the terminal
- [ ] **Config loading**: `src/config.ts` should fall back to Keychain (via `security find-generic-password`) when a required env var is missing from `.env`. This lets honeypot-stored credentials work without duplicating them in `.env`.
- [ ] **Ship honeypot in the npm package**: add `scripts/honeypot` to the `files` whitelist in `package.json`, wire `"bin": { "honeypot": "scripts/honeypot" }` so it's available globally after `npm i -g`

### Track 11: `hive doctor`

**What's needed**: A diagnostic command that a CEO can run when something's wrong, and May can read the output remotely.

- [ ] Check all prereqs are installed and running (MongoDB, Ollama, Qdrant, Node version)
- [ ] Check MongoDB connectivity, database exists, agent definitions present
- [ ] Check Slack connection (tokens valid, socket mode connected)
- [ ] Check Anthropic key valid (test API call)
- [ ] Check LaunchAgent status
- [ ] Check MCP server health (can they spawn?)
- [ ] Output: clear pass/fail per check, actionable fix instructions

### Track 12: `hive update`

- [ ] Stop LaunchAgent → `npm update -g @keepur/hive` → restart
- [ ] Check `hiveApi` compat with installed plugins before restarting
- [ ] Warn if incompatible plugins found

### Track 13: `hive start --daemon` (LaunchAgent)

**What exists**: `setup/generate-plist.ts` for the dev deploy model.

**What's needed**:
- [ ] Adapt plist generation for global npm install paths (resolve node, package root, HIVE_HOME at generation time)
- [ ] All paths fully resolved (no `~` — launchd doesn't expand it)
- [ ] Symlink to `~/Library/LaunchAgents/`
- [ ] `hive stop` unloads the LaunchAgent

### Track 14: Monitoring / Health Signal

**Should-have, not must-have for first cohort.**
- [ ] Heartbeat endpoint or log shipping so May knows when a customer's hive is unhealthy
- [ ] Could be as simple as a daily "I'm alive" Slack message from CoS to a Keepur channel

### Track 15: Agent Builder Skill

**Spec**: `2026-04-08-agent-builder-design.md` (ready)
**Should-have.** CoS can create agents via admin MCP tools as a fallback, but the agent builder skill makes it conversational and guided.

### Track 16: Customer-Facing Docs

- [ ] Install guide (the email content + detailed steps)
- [ ] Prereqs list with expected install times
- [ ] Slack app creation walkthrough (screenshots)
- [ ] Google OAuth walkthrough (screenshots)
- [ ] Troubleshooting / FAQ
- [ ] Support channel: where do they report issues?

### Track 17: npm Publish Pipeline

- [ ] `@keepur` npm org exists
- [ ] `npm publish` from dev machine (manual is fine for MVP)
- [ ] `npm pack --dry-run` verification step
- [ ] `.npmrc` with auth token on dev machine
- [ ] Verify installed package size is reasonable

### Track 18: License Decision

**Must decide before first publish.**
- [ ] Closed-source (minified, no license file) — the old spec's assumption
- [ ] Source-available (BSL, SSPL, or similar) — see-but-don't-compete
- [ ] MIT/Apache (open source) — unlikely for core, but Beekeeper already went this way
- [ ] Dual license — open core + commercial add-ons

This is a business decision, not an engineering one. But it must happen before `npm publish`.

### Track 19: Versioning Strategy

- [ ] Semver? CalVer?
- [ ] `hiveApi` version (for plugin compat) — is this the same as the package version or a separate field?
- [ ] First version: `0.1.0`? `1.0.0`?

---

## Dependency Graph (Critical Path)

```
Track 3 (prereqs) ──────────────────────────────┐
Track 9 (HIVE_HOME config) ─────────────────────┤
Track 4 (CoS seed) ─────────────────────────────┤
Track 18 (license) ─────────────────┐           │
Track 19 (versioning) ──────────────┤           │
                                    ├→ Track 17 (npm publish)
Track 1 (build pipeline validation) ┤           │
Track 5 (agent runner paths) ───────┘           │
                                                ├→ Track 2 (hive init wizard)
Track 10 (credential flow) ────────────────────┤
                                                ├→ Track 16 (docs)
Track 8 (registry content) ────────────────────┤
Track 6 (plugin arch impl) ───────────────────┘
Track 7 (skills registry) ────────────────────→ (can follow shortly after)
```

**Shortest path to "CEO talks to CoS in Slack":**
Tracks 1 + 3 + 4 + 5 + 9 + 10 + 2 + 17 + 18

Track 10 is partially done (`scripts/honeypot` exists, keychain MCP server already reads from it). Remaining work is integration into `hive init` and `src/config.ts` Keychain fallback.

**That path does NOT require**: plugin registry, skills registry, Google OAuth, agent builder, monitoring, docs beyond the install email. Those come in the days/weeks after, delivered via `hive update`.

---

## Proposed Phasing

### Phase 0: "Hello World" (Target: ship ASAP)

The CEO installs, runs `hive init`, and talks to CoS in Slack. CoS has memory, can schedule, can create agents via admin tools. No plugins, no skills registry, no Google yet.

**Tracks**: 1, 2, 3, 4, 5, 9, 10 (Anthropic + Slack only), 13, 17, 18, 19
**Docs**: One-page install guide in the email

### Phase 1: "Capable Assistant" (Target: 1 week after Phase 0)

CoS can connect to Google (email, calendar, drive). `hive doctor` works. `hive update` works. CoS guides Google OAuth from Slack conversation.

**Tracks**: 10 (Google OAuth), 11, 12

### Phase 2: "Build Your Team" (Target: 2 weeks after Phase 0)

Plugin registry operational. CoS can recommend and install plugins. Agent builder skill lets CoS create custom agents conversationally. Skills registry operational.

**Tracks**: 6, 7, 8, 15

### Phase 3: "Production Ready"

Monitoring. Full docs. Upgrade compat checking. Health heartbeats. Customer-space write guard. The polished experience.

**Tracks**: 14, 16 (full), remaining Track 7 hardening

---

## KPR-29 Dependency

KPR-29 (in flight) introduces the `hive_composition` MongoDB collection — the authoritative manifest of what's installed on an instance. This spec consumes that collection:

- `hive init` writes the initial composition row (instance identity, empty plugins/skills)
- `hive plugin add` updates composition
- `hive skill add` updates composition
- `hive doctor` reads composition to verify integrity

If KPR-29's schema shifts, only the composition-touching code in Tracks 2, 6, 7, and 11 needs updating. The installer flow and build pipeline are unaffected.

## Open Decisions (Need Answers Before Phase 0)

1. ~~**License**~~ — **Resolved: closed-source.** Minified bundles only, no LICENSE file, no source. npm package ships `pkg/` (minified), `seeds/`, `templates/`, `scripts/honeypot`. No `src/`, no `dist/`, no tests.
2. ~~**Version**~~ — **Resolved: `0.1.0`.** Preview release.
3. ~~**What MCP servers are "core" vs "plugin"?**~~ — **Resolved in #135.** Dodi-specific servers (dodi-ops, hubspot-crm, crm-search, product-search, ops-search, permits, catalog) are plugins. Everything else stays in core: Google, Linear, ClickUp, GitHub Issues, Resend, Quo, memory, contacts, schedule, admin, callback, keychain, search-conversation, background-task, recall, task, event-bus, team, code-search, code-task, workflow, voice, structured-memory. CoS has Google on day one.
4. ~~**CoS credential writing**~~ — **Resolved: `scripts/honeypot`.** A macOS Keychain wrapper that stores credentials under `hive/<instance-id>/<KEY>`. The keychain MCP server already reads these entries. `hive init` uses `honeypot set` for Anthropic + Slack tokens. CoS guides users to run `honeypot set` for post-init credentials (Google OAuth, plugin API keys). Coexists with `.env` for existing deploys.
