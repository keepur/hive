# Skills System Design

**Status:** Draft — pending review
**Author:** Mokie + Claude (brainstorm session 2026-04-14)
**Related:** #137 (this ticket, now narrowed to documentation + small loader extensions), plugin architecture spec (`docs/specs/2026-04-14-plugin-architecture-design.md`)

---

## 1. Problem

Skills already work in Hive today. `src/agents/skill-loader.ts` scans a `skills/` directory, parses SKILL.md frontmatter, and attaches matching skills to each agent via the Claude Agent SDK's local-plugin loading path. Agents invoke skills at runtime the same way they invoke any other SDK-provided playbook. Five workflows and thirteen skills exist in the repo today, including a real multi-agent coordination example (`morning-briefing`) that dispatches work across five department agents.

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

Current workflows in the repo:

- `agent-builder/` — `build-agent`
- `inbound-triage/` — `inbound-lead-triage`
- `jasper-reports/` — `deploy-report`, `blocker-alert`
- `morning-briefing/` — `morning-briefing`, `sales-standup-prep`, `cs-standup-prep`, `dev-standup-prep`, `marketing-standup-prep`, `production-standup-prep`
- `project-tools/` — `quality-gate`, `dev-servers`, `create-tests`

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

Body is free-form markdown. Agents read the prose and execute whatever it describes. Structure is a property of the prose, not the loader — a skill can be a rigid step-by-step list, a loose guidance document, or anything in between.

### 4.3 Loader behavior

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
2. Writes `skills/<workflow>/skills/<skill-name>/SKILL.md` with frontmatter setting `agents: [<self-id>]`.
3. The skill is picked up on the next skill-index reload (currently requires a Hive restart or SIGUSR1 + loader hot reload — see §6.2).

This is how Milo writes his own morning-briefing helpers today. It's crude but it works, and it's consistent with how the rest of the hive treats agent authorship — agents have real tools and use them.

## 5. Trust and Distribution

The same posture the plugin architecture spec establishes applies to skills. This section documents it so it's not only written down in the plugin spec.

### 5.1 Principle

**Agents are employees, not hangout partners you met at an overnight party.** Any skill that runs on a hive is assumed to have the same access as any other prose loaded into an agent's context — it can instruct the agent to call tools, read state, write files. The skill system does not police that; the agent does (with whatever guardrails the beekeeper has configured) and the architectural layer below does (Honeypot + Keychain keeps credentials out of cloud-model-facing context regardless of what a skill says).

Under the Honeypot architectural guarantee (#139), the worst outcome from a malicious skill is **business-operational harm**: wrong emails sent, wrong CRM records created, wrong Slack posts, budget burn. All recoverable. Credentials are not reachable from any agent a skill can be loaded into, because agents don't hold credentials — MCP servers do, and cloud-model-facing agents have no Keychain read entitlement.

That narrower threat model is the reason the skill spec does not need per-skill capability scoping, runtime tool restriction, or automated review. Registry curation + agent-visibility scoping is sufficient for what remains.

### 5.2 Origin categories

Every skill on a hive falls into exactly one of four origin categories:

1. **Shipped with Hive core.** Lives in the `skills/` directory of the hive repo. Distributed through the same channel as the rest of the core code. If you trust Hive enough to run it, you trust its bundled skills.

2. **Shipped inside a plugin.** Lives in the plugin's `skills/` subdirectory and is loaded by the skill loader when the plugin is installed. Trust is inherited from the plugin — if you trust the plugin enough to install it, you trust its skills.

3. **Installed from a skill registry.** Same pattern as plugins: a JSON registry file (Keepur-hosted default, third-party registries configurable, local file registries supported) maps skill short-names to downloadable sources. `hive skill add <name>` resolves against the registries the beekeeper has configured. The curator of the registry is the reviewer of record.

4. **Agent-authored at runtime.** An agent writes a skill for itself via the Write tool. Private to the authoring agent by default (`agents: [<self-id>]`). Promotion to other agents or hive-wide requires the beekeeper reading the skill and flipping the `agents:` field. There is no automated promotion path.

**There is no raw-URL install path for skills.** Unlike plugins, which have a `--dev-mode` escape hatch for plugin authors testing unpublished work, skills do not need one: a plugin author iterating on a skill is either (a) editing a file already in their workspace that gets picked up on the next reload, or (b) iterating on a plugin-bundled skill via the plugin's own dev-mode install. There is no legitimate use case for "paste a skill URL into a production hive," so the path simply does not exist. This asymmetry vs plugins is intentional.

### 5.3 How a beekeeper gets a skill they found on the internet

Same workflow as plugins: read it, verify it, adapt it for a business-agent context if needed (many internet skills are written for developer agents and need retargeting), then either submit upstream to a registry the beekeeper trusts or add it to a local registry file. The skill enters the hive through deliberate adoption, not a one-click install.

## 6. What Changes in Code

Two small code changes are required to wire the existing loader into the plugin architecture and to support hot reload. Both are forward compatible with the existing skills today.

### 6.1 Plugin-bundled skills

`src/agents/skill-loader.ts` currently scans only the top-level `skills/` directory. Extend it to also scan `<plugin-dir>/skills/` for each loaded plugin. The loader receives the list of loaded plugins (already available in the runtime — plugins are loaded before the skill index is built). For each plugin, if the plugin directory contains a `skills/` subdirectory with the same two-level layout, load those skills into the same index.

Ordering: core-bundled skills are loaded first, plugin-bundled skills are loaded after. Name collisions between core and plugin skills are logged as warnings and core wins (because core is explicitly opinionated and plugins should not shadow it). Name collisions between two plugins are logged as warnings and the first-loaded plugin wins (order of plugin installation, preserved in the composition record).

### 6.2 Hot reload on SIGUSR1

`src/index.ts` handles SIGUSR1 to reload agent definitions from Mongo. Extend the same signal handler to also rebuild the skill index. This makes agent-authored skills effective without a restart: agent writes SKILL.md → admin sends SIGUSR1 (or the agent can ask the admin MCP tool to signal reload) → new skill is available on next agent turn.

No new file. The signal handler in `src/index.ts` already calls the agent-registry reload path; it just needs an additional call to rebuild the skill index and re-bind it into the agent runner's state.

## 7. CLI Surface (Reserved, Not Built)

When registries actually exist, the beekeeper will install and manage skills via:

```
hive skill add <name>          # install from a configured registry
hive skill remove <name>       # delete from this hive's skills directory
hive skill list                # show installed skills with origin + visibility
hive skill enable <name> --agent <agent-id>
hive skill disable <name> --agent <agent-id>
```

The plugin architecture spec already defines the registry mechanism (§7.2 of that spec). Skill registries use the same JSON format and the same trust model — just pointing at skill packages instead of plugin packages.

**None of these CLI commands are implemented in this round.** They are reserved here so that when the first skill registry materializes, the CLI shape is not re-litigated. Reserving the surface is free; building it before there's content is wasted work.

Agent-visibility management (`hive skill enable --agent`) is a future convenience for the beekeeper. Today the equivalent is editing the `agents:` frontmatter field in the SKILL.md file directly. That remains valid indefinitely as a manual path.

## 8. Agent-Authored Skill Promotion

Today's workflow:

1. Agent writes a SKILL.md with `agents: [<self>]`.
2. Skill index reloads, the agent can now invoke the skill.
3. Beekeeper discovers the skill (by looking at the filesystem, or by the agent mentioning it in conversation).
4. Beekeeper reads the skill's prose and decides whether to promote.
5. Beekeeper edits the `agents:` frontmatter directly — e.g., `agents: [milo, jessica]` or `agents: [all]`.
6. SIGUSR1 reloads the index, skill is now visible to the promoted audience.

This is a manual, low-ceremony process and it is sufficient for the next 3+ months. If agent-authored skills become numerous enough that manual discovery and review don't scale — say, more than a handful per week across all agents — we revisit with a discovery dashboard and a promotion queue. Not before.

**The beekeeper is always the gate for promotion.** An agent cannot make one of its skills visible to another agent without beekeeper involvement. This is a deliberate trust choice: agents can grow their own toolkits but cannot unilaterally change what peers see.

## 9. Open Questions Deferred

- **Registry content.** No skill registries exist today. When the first one lights up, the CLI surface from §7 needs to be implemented and the registry JSON format needs to match the plugin registry format. Same ticket, later.
- **Mongo storage for agent-authored skills.** If filesystem storage turns out to have lifecycle problems (skills accumulating with no cleanup, hard to query across agents, etc.), migrate agent-authored skills to Mongo in a dedicated collection with the same shape as the filesystem SKILL.md. Not needed now.
- **Retargeting skills from developer-agent context to business-agent context.** Most Claude Code skills in the wild are written for dev workflows. A hypothetical "skill adaptation assistant" that helps a beekeeper retarget an internet skill for a CRM or CS agent is interesting future work but not load-bearing for anything on the critical path.

## 10. Acceptance Criteria

This spec is done when:

1. The current skill system is documented authoritatively enough that a new contributor can understand what skills are, how to write one, and how they load — without reading the loader source.
2. The trust and distribution posture for skills is written down in one place and consistent with the plugin architecture spec.
3. The two small code changes in §6 are specified clearly enough to be implemented without further design.
4. The CLI surface is reserved so future registry work doesn't need a new spec round.
5. The agent-authored promotion workflow is stated explicitly, so there's no ambiguity about who the gate is.
