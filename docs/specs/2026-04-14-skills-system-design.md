# Skills System Design

**Status:** Draft — pending review
**Amended:** 2026-04-15 by `docs/specs/2026-04-15-skills-customer-space-design.md` §12.1 and `docs/specs/2026-04-15-skills-registry-design.md` §14.1. See §§5.2, 6, 7, 8, 9, 4.2 for the amended content and §§1, 4.1, 4.3, 4.4 for downstream consistency updates.
**Author:** Mokie + Claude (brainstorm session 2026-04-14)
**Related:** #137 (this ticket, now narrowed to documentation + small loader extensions), plugin architecture spec (`docs/specs/2026-04-14-plugin-architecture-design.md`)

---

## 1. Problem

Skills already work in Hive today. `src/agents/skill-loader.ts` scans a `skills/` directory, parses SKILL.md frontmatter, and attaches matching skills to each agent via the Claude Agent SDK's local-plugin loading path. Agents invoke skills at runtime the same way they invoke any other SDK-provided playbook. Five workflows and thirteen skills existed in the repo at the time of writing (2026-04-14), including a real multi-agent coordination example (`morning-briefing`) that dispatches work across five department agents. *As of 2026-04-15, those skills are being triaged for the default Keepur registry per `2026-04-15-skills-customer-space-design.md` §10.3 — they are not long-term inhabitants of the `<repo>/skills/` tree, and future hive versions will ship with that directory removed from the package manifest.*

The problem is not that skills are missing. The problem is that skills are **undocumented as a first-class concept**, so:

- Future design discussions treat them as an open question when they're actually settled infrastructure.
- Plugin authors have no spec telling them how to ship skills bundled with a plugin, even though the plugin architecture spec (§5) reserved a `skills` field for exactly this.
- The trust/distribution posture established for plugins (registry-first, raw URL as dev-mode escape hatch) is not written down anywhere for skills, so it's easy to forget the same rules apply.

This spec fixes that. It authoritatively documents the existing system, writes down the forward-looking trust model, and calls out two small loader extensions needed to integrate with the plugin architecture. It is not a greenfield design.

## 2. Goals

1. Document the current skill format, loader, and visibility mechanism so the system has a canonical reference.
2. State the trust and distribution posture for skills, mirroring the plugin architecture spec.
3. Define how plugin-bundled skills integrate with the existing loader (small code change).
4. Reserve the CLI surface for the registry-based skill distribution path, to be implemented when registries actually exist.
5. Make it clear that agent-authored skills are a supported path today and describe the promotion workflow.

## 3. Non-Goals

- **New storage backend.** Skills live on disk as files today. Migration to Mongo is not in scope — if it ever becomes necessary, it's a separate ticket.
- **Typed parameter schemas.** Skills are free-form prompt text. Agents figure out what inputs they need from the invocation context. Do not add a parameter DSL.
- **Skill-invokes-skill plumbing.** Cross-skill coordination is prose-level. The morning-briefing skill proves this works. Do not build a mechanical invocation graph.
- **Skill versioning / history.** Skills are mutable markdown. Git tracks history for shipped skills; Mongo-history is out of scope for agent-authored skills in this round.
- **Model-based security review.** A local or cloud model classifying a skill as "safe" is developer ergonomics, not a security gate. Do not ship it as a trust mechanism.
- **A full registry CLI implementation.** There are zero external skill registries today. The CLI surface is *reserved*, not built.

## 4. What Exists Today

### 4.1 Storage layout

```
skills/
├── <workflow-name>/
│   └── skills/
│       └── <skill-name>/
│           ├── SKILL.md        # frontmatter + prose
│           └── <supporting files, optional>
```

Two-level nesting. The outer `<workflow-name>` directory groups related skills. The inner `skills/` level is required by the Claude Agent SDK's local-plugin loading format — we cannot flatten it without reimplementing skill loading from scratch, which is not worth it. Treat the workflow level as a file-organization convenience, not a semantic unit.

Workflows that existed in the repo at the time of writing (2026-04-14), for historical reference:

- `agent-builder/` — `build-agent`
- `inbound-triage/` — `inbound-lead-triage`
- `jasper-reports/` — `deploy-report`, `blocker-alert`
- `morning-briefing/` — `morning-briefing`, `sales-standup-prep`, `cs-standup-prep`, `dev-standup-prep`, `marketing-standup-prep`, `production-standup-prep`
- `project-tools/` — `quality-gate`, `dev-servers`, `create-tests`

Under the current design (`2026-04-15-skills-customer-space-design.md`), the `<repo>/skills/` tree is not the authoritative location for customer-owned skills at runtime — that role belongs to `<hiveHome>/skills/` (the instance directory, e.g. `~/services/hive/skills/`). The `skills/` directory at both the repo root and the instance root is gitignored; shipped skills are no longer stored there but instead bundled inside plugins at `<pluginDir>/skills/` or installed from the Keepur registry into customer space. The enumeration above is historical and reflects the state of the repo on 2026-04-14, before the customer-space partition was specified. See `2026-04-15-skills-customer-space-design.md` for the ownership model and `2026-04-15-skills-registry-design.md` for registry-based distribution.

### 4.2 SKILL.md format

```markdown
---
name: morning-briefing
description: Aggregate all standup prep reports into a unified morning briefing
agents:
  - chief-of-staff
---

# Morning Briefing

<free-form prose: steps, decision points, output format, whatever the author wants>
```

Frontmatter fields:

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | yes | Skill identifier, must be unique within its workflow |
| `description` | yes | One-line summary shown to agents during discovery |
| `agents` | yes | List of agent IDs that can see this skill, or `[all]` for hive-wide visibility |
| `workflow` | recommended | Runtime workflow-grouping directory name. Used by the installer's projection rule per `2026-04-15-skills-registry-design.md` §7.2. Required for registry-published skills; recommended for agent-authored with installer fallback (skill becomes its own single-skill workflow when absent). |

Body is free-form markdown. Agents read the prose and execute whatever it describes. Structure is a property of the prose, not the loader — a skill can be a rigid step-by-step list, a loose guidance document, or anything in between.

Customer-space SKILL.md files additionally carry `origin:` and `author:` metadata defined by `2026-04-15-skills-customer-space-design.md` §6.2, which is the authoritative contract for the customer-space frontmatter shape.

### 4.3 Loader behavior

**Forward pointer for the KPR-29 loader model:** the current §4.3 description reflects the loader's 2026-04-14 behavior, which scans `<repo>/skills/` only. Under the end-state defined by `2026-04-15-skills-customer-space-design.md` §6.4, the loader scans `<plugin-dir>/skills/` for each installed plugin (added in §6.1 of this spec, ships with #137) *and* `<instance-dir>/skills/` for customer-space content (§6.3 of this spec, ships with KPR-29). The `<repo>/skills/` scan is removed entirely when KPR-29 ships. Readers implementing #137 should retain the `<repo>/skills/` scan as-is and only add the plugin-tree scan.

`src/agents/skill-loader.ts` exposes `loadSkillIndex(skillsDir)` and `getSkillsForAgent(index, agentId)`.

- At boot, scan each top-level directory under `skills/`. For each directory, look for `skills/<skill-name>/SKILL.md`.
- Parse YAML frontmatter. Collect the union of all `agents:` fields declared across skills in that workflow.
- If any skill in the workflow has `agents: [all]`, the whole workflow is registered as universal and attached to every agent at lookup time.
- Otherwise, the workflow is attached to each explicitly-listed agent.
- Skills are handed to the Claude Agent SDK as a `{ type: "local", path: "<workflow-dir>" }` plugin config. The SDK handles discovery and invocation from there.

**Scope granularity is per-skill in frontmatter but per-workflow in loading.** A workflow whose skills have mixed visibility (some for Milo, some for Jessica) loads the whole workflow into both agents' plugin lists; the SDK surfaces only the skills whose frontmatter matches. This is a minor subtlety, not a bug — it means you can co-locate related skills with different audiences in one workflow directory.

### 4.4 Agent-authored skills

Agents have filesystem tools under `bypassPermissions` and can write new SKILL.md files directly. No special MCP tool is required. An agent authoring a skill for itself:

1. Picks a workflow directory (or creates a new one).
2. Writes a SKILL.md with frontmatter setting `agents: [<self-id>]` at `<instance-dir>/skills/<workflow>/skills/<skill-name>/SKILL.md` (customer space under the KPR-29 model; historical pre-KPR-29 path was `<repo>/skills/<workflow>/skills/<skill-name>/SKILL.md`). Under KPR-29's write guard (`2026-04-15-skills-customer-space-design.md` §6.3) the filesystem Write tool enforces that SKILL.md writes land only inside `<instance-dir>/skills/`, so the historical path is no longer even reachable for agent-authored content.
3. The skill is picked up on the next skill-index reload (currently requires a Hive restart or SIGUSR1 + loader hot reload — see §6.2).

This is how Milo writes his own morning-briefing helpers today. It's crude but it works, and it's consistent with how the rest of the hive treats agent authorship — agents have real tools and use them.

## 5. Trust and Distribution

The same posture the plugin architecture spec establishes applies to skills. This section documents it so it's not only written down in the plugin spec.

### 5.1 Principle

**Agents are employees, not hangout partners you met at an overnight party.** Any skill that runs on a hive is assumed to have the same access as any other prose loaded into an agent's context — it can instruct the agent to call tools, read state, write files. The skill system does not police that; the agent does (with whatever guardrails the beekeeper has configured) and the architectural layer below does (Honeypot + Keychain keeps credentials out of cloud-model-facing context regardless of what a skill says).

Under the Honeypot architectural guarantee (#139), the worst outcome from a malicious skill is **business-operational harm**: wrong emails sent, wrong CRM records created, wrong Slack posts, budget burn. All recoverable. Credentials are not reachable from any agent a skill can be loaded into, because agents don't hold credentials — MCP servers do, and cloud-model-facing agents have no Keychain read entitlement.

That narrower threat model is the reason the skill spec does not need per-skill capability scoping, runtime tool restriction, or automated review. Registry curation + agent-visibility scoping is sufficient for what remains.

### 5.2 Origin categories

Every skill on a hive falls into exactly one of three origin categories:

1. **Shipped inside a plugin.** Lives in the plugin's `skills/` subdirectory and is loaded by the skill loader when the plugin is installed. Trust is inherited from the plugin — if you trust the plugin enough to install it, you trust its skills.

2. **Installed from a skill registry.** Same pattern as plugins: a JSON registry file (Keepur-hosted default, third-party registries configurable, local file registries supported) maps skill short-names to downloadable sources. `hive skill add <name>` resolves against the registries the beekeeper has configured. The curator of the registry is the reviewer of record.

3. **Agent-authored at runtime.** An agent writes a skill for itself via the Write tool. Private to the authoring agent by default (`agents: [<self-id>]`). Promotion to other agents or hive-wide requires the beekeeper reading the skill and flipping the `agents:` field. There is no automated promotion path.

See `2026-04-15-skills-customer-space-design.md` §5 for the full ownership model under the current design. This spec's origin-category list is the historical four-category model; the "Shipped with Hive core" category has since been collapsed (`2026-04-15-skills-customer-space-design.md` §5.4) because the core tarball ships zero skills — what used to be "shipped" is now "available in the default Keepur registry" per the registry spec.

**There is no raw-URL install path for skills.** Unlike plugins, which have a `--dev-mode` escape hatch for plugin authors testing unpublished work, skills do not need one: a plugin author iterating on a skill is either (a) editing a file already in their workspace that gets picked up on the next reload, or (b) iterating on a plugin-bundled skill via the plugin's own dev-mode install. There is no legitimate use case for "paste a skill URL into a production hive," so the path simply does not exist. This asymmetry vs plugins is intentional.

### 5.3 How a beekeeper gets a skill they found on the internet

Same workflow as plugins: read it, verify it, adapt it for a business-agent context if needed (many internet skills are written for developer agents and need retargeting), then either submit upstream to a registry the beekeeper trusts or add it to a local registry file. The skill enters the hive through deliberate adoption, not a one-click install.

## 6. What Changes in Code

> **Scope note.** This section describes the full end-state loader work, not all of which ships in a single ticket. **§6.1 (Plugin-bundled skills) and §6.2 (Hot reload on SIGUSR1) ship with hive issue #137** — the ticket this spec was originally filed for. **§6.3 (Customer-space skills) ships with KPR-29**, the follow-on ticket that owns the customer-space ownership partition and the registry CLI. A future reader picking up #137 should implement §6.1 and §6.2 only; §6.3 is intentionally out of scope for #137.

Two small code changes are required to wire the existing loader into the plugin architecture and to support hot reload. Both are forward compatible with the existing skills today.

### 6.1 Plugin-bundled skills

`src/agents/skill-loader.ts` currently scans only the top-level `skills/` directory via `loadSkillIndex(skillsDir?: string): SkillIndex`, called with no argument from `AgentManager` (which relies on the default `resolve("skills")`). Extend it to also scan `<plugin-dir>/skills/` for each loaded plugin.

**Signature change.** Change `loadSkillIndex` to accept an optional second argument:

```ts
loadSkillIndex(skillsDir?: string, plugins?: LoadedPlugin[]): SkillIndex
```

where `LoadedPlugin` is the existing type from `src/plugins/types.ts` (its `dir` field is the absolute path used as `<plugin-dir>`). When `plugins` is provided, after scanning `skillsDir` the loader iterates the list in order, and for each plugin whose `<plugin-dir>/skills/` exists, scans it using the same two-level layout (`<workflow>/skills/<skill>/SKILL.md`) and merges results into the same index.

**Call-site change.** `AgentManager` constructs the index at `src/agents/agent-manager.ts` line 50 and rebuilds it in `reloadSkills()` (lines 64–70). Both call sites must pass `this.plugins` (already populated at line 49, before the initial `loadSkillIndex()` call). No other callers exist.

**Collision rule.** Collision is detected at the **workflow-directory-name level** (not the frontmatter `name:` field). This matches how the loader already groups skills: one `SdkPluginConfig` per workflow directory, keyed by path. Detection approach:

- The loader maintains an in-memory `Map<string, { source: "core" | pluginName; path: string }>` during the load pass, keyed by the **bare workflow directory entry name** as returned by `readdirSync` (e.g., `"morning-briefing"`), not by the full absolute path. Using the bare name is what makes the collision fire — two plugins each shipping a `morning-briefing/` workflow resolve to different absolute paths but must be detected as a collision.
- Before registering a workflow, check the map. If absent, insert and proceed. If present, this is a collision: log a warning via the existing `log.warn(...)` helper and skip registration of the new workflow.
- Ordering: core (`<repo>/skills/`) is scanned first, then plugins in the order they appear in the `plugins` array. Input order is preserved by `loadPlugins` in `src/plugins/plugin-loader.ts` (it iterates the input `pluginNames` array and pushes to the result in sequence), and `pluginNames` originates from `hive.yaml` config order. This gives the precedence the spec requires: core > first-loaded plugin > later-loaded plugin, deterministically from the config file.
- Warning log shape (structured, matching the rest of the codebase). The `workflow` field is the bare directory name used as the collision-map key:
  ```ts
  log.warn("Skill workflow collision — keeping first, skipping second", {
    workflow,                                                       // e.g. "morning-briefing"
    kept: { source: "core" | <pluginName>, path: <absolutePath> },
    skipped: { source: <pluginName>, path: <absolutePath> },
  });
  ```

**Note on pre-existing debug log.** `skill-loader.ts` line 36 currently logs `"Workflow missing .claude/skills/, skipping"` — the `.claude/` fragment is stale (actual check is `<workflow>/skills/`). Fix the message in the same PR to avoid confusion when debugging plugin-dir scans.

### 6.2 Hot reload on SIGUSR1

**Status: already implemented; no code change required for this subsection.** As of the current codebase, `src/index.ts` `reload()` at lines 65–93 already calls `agentManager.reloadSkills()` at line 92, and the SIGUSR1 handler wires to `reload()`. `AgentManager.reloadSkills()` at `src/agents/agent-manager.ts` lines 64–70 calls `loadSkillIndex()` and replaces `this.skillIndex`. Agent-authored SKILL.md writes become effective on the next SIGUSR1 (or on the existing `fs.watch` trigger for `<repo>/skills/`) without a restart.

The #137 implementer should verify this behavior end-to-end (write a SKILL.md, send SIGUSR1, confirm the skill is picked up) and make sure the §6.1 signature change flows through `reloadSkills()` — i.e., `reloadSkills()` must also pass `this.plugins` to `loadSkillIndex()` so hot reload sees plugin-bundled skills, not just core skills. That is the only §6.2-adjacent code touch this ticket needs.

This subsection is retained in the spec for documentation completeness and to make the hot-reload guarantee explicit — a future reader looking for "how do agent-authored skills become live" should find the answer here.

### 6.3 Customer-space skills (KPR-29 scope, not #137)

`2026-04-15-skills-customer-space-design.md` §6.3–§6.5 defines a third change to `src/agents/skill-loader.ts`: remove the existing `<repo>/skills/` scan (§6.5 of that spec), add a scan of `<instance-dir>/skills/` (§6.4), and add a write guard on agent SKILL.md writes that captures provenance and enforces the customer-space path constraint (§6.3). Combined with the boot-time integrity check in that spec's §7, this partitions the filesystem so agent-authored content lives in customer space while the package tree stays in its shipped shape.

**This subsection is KPR-29's scope, not #137's.** #137 ships with the `<repo>/skills/` scan still in place alongside the new plugin-bundled scan from §6.1 — the two coexist during the transition window, and KPR-29 later removes the `<repo>/skills/` scan when it introduces the customer-space path. See `2026-04-15-skills-customer-space-design.md` §12.1 for the full list of amendments this spec will receive when KPR-29 ships.

## 7. CLI Surface (Specified in registry spec)

The skill registry CLI commands are specified in `2026-04-15-skills-registry-design.md` §7 through §11, which owns the full contract for `hive skill add`, `hive skill remove`, `hive skill list`, and `hive skill upgrade`. That spec covers:

- Command signatures, flags, and output format
- Multi-registry configuration and resolution (via `hive registry add/list/remove`)
- Upgrade-with-diff semantics (three-way merge when modified, two-way degraded fallback)
- Fetch-layer error handling
- Offline and local-path installs via `file://` URLs

**Registry model asymmetry with plugins.** `2026-04-15-skills-customer-space-design.md` §4.4 documents why the skills registry posture is deliberately simpler than the plugin registry posture from `2026-04-14-plugin-architecture-design.md` §7.2: skills have a narrower threat model (business-operational harm only, not credential exfiltration) because credentials are held by plugin MCP servers, not by skills. Consequently, the skills registry supports arbitrary git URLs with no `--dev-mode` flag or trust-curation gate, and the default registry is a plain open-source GitHub repo (`github.com/keepur/hive-skills`) rather than a curated JSON manifest.

**Still future work:** `hive skill enable --agent <agent-id>` and `hive skill disable --agent <agent-id>` remain unimplemented. The manual equivalent today is editing the `agents:` frontmatter field in the installed SKILL.md file directly. That manual path remains valid indefinitely as a fallback.

## 8. Agent-Authored Skill Promotion

Today's workflow:

1. Agent writes a SKILL.md with `agents: [<self>]` at `<instance-dir>/skills/<workflow>/skills/<skill-name>/SKILL.md` (customer space, per `2026-04-15-skills-customer-space-design.md` §5.3 and §6.3 — the write guard enforces the customer-space path constraint and injects `origin.type: agent-authored` plus author provenance metadata). Under the historical pre-KPR-29 model the path was `<repo>/skills/...`, but KPR-29 relocates customer-owned content to `<instance-dir>/skills/` and partitions the filesystem so agent writes cannot land outside customer space.
2. Skill index reloads, the agent can now invoke the skill.
3. Beekeeper discovers the skill (by looking at the filesystem, or by the agent mentioning it in conversation).
4. Beekeeper reads the skill's prose and decides whether to promote.
5. Beekeeper edits the `agents:` frontmatter directly — e.g., `agents: [milo, jessica]` or `agents: [all]`.
6. SIGUSR1 reloads the index, skill is now visible to the promoted audience.

This is a manual, low-ceremony process and it is sufficient for the next 3+ months. If agent-authored skills become numerous enough that manual discovery and review don't scale — say, more than a handful per week across all agents — we revisit with a discovery dashboard and a promotion queue. Not before.

**The beekeeper is always the gate for promotion.** An agent cannot make one of its skills visible to another agent without beekeeper involvement. This is a deliberate trust choice: agents can grow their own toolkits but cannot unilaterally change what peers see.

## 9. Open Questions Deferred

- **Registry content.** No skill registries exist today. When the first one lights up, the CLI surface from §7 needs to be implemented and the registry JSON format needs to match the plugin registry format. Same ticket, later.
- **Mongo storage for agent-authored skills.** If filesystem storage turns out to have lifecycle problems (skills accumulating with no cleanup, hard to query across agents, etc.), migrate agent-authored skills to Mongo in a dedicated collection with the same shape as the filesystem SKILL.md. Not needed now. *Update 2026-04-15: the deferral condition ("if filesystem storage turns out to have lifecycle problems") has not been triggered. The problems observed on Mike's mac-mini and in the retroactive discovery of the current `skills/` tree turned out to be ownership-partition problems, not storage-substrate problems, and KPR-29's customer-space model addresses them fully without requiring Mongo. See `2026-04-15-skills-customer-space-design.md` §11.2.*
- **Retargeting skills from developer-agent context to business-agent context.** Most Claude Code skills in the wild are written for dev workflows. A hypothetical "skill adaptation assistant" that helps a beekeeper retarget an internet skill for a CRM or CS agent is interesting future work but not load-bearing for anything on the critical path.

## 10. Acceptance Criteria

This spec is done when:

1. The current skill system is documented authoritatively enough that a new contributor can understand what skills are, how to write one, and how they load — without reading the loader source.
2. The trust and distribution posture for skills is written down in one place and consistent with the plugin architecture spec.
3. The two small code changes in §6 are specified clearly enough to be implemented without further design.
4. The CLI surface is cross-referenced to `2026-04-15-skills-registry-design.md` §7–§11, which is the authoritative source for `hive skill add/list/upgrade/remove` and `hive registry add/list/remove` semantics. This spec's §7 is a forward pointer, not the contract.
5. The agent-authored promotion workflow is stated explicitly, so there's no ambiguity about who the gate is.
