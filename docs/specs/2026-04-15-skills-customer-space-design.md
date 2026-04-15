# Skills Customer-Space Ownership Model

**Status:** Draft — pending review
**Author:** Mokie + Claude (brainstorm session 2026-04-15)
**Related:**
- `2026-04-14-skills-system-design.md` — amended by this spec (§5.2 origin categories, §7 CLI surface, §8 promotion)
- `2026-04-14-plugin-architecture-design.md` — extended by this spec (§7.1 zero-plugins rule gains a parallel for skills)
- KPR-29 — this spec resolves the design question raised by the agent-on-deploy commit workflow incident on 2026-04-15
- Companion: `2026-04-15-skills-registry-design.md` — covers the registry interaction mechanics this spec points to

---

## 1. Problem

On 2026-04-15, while reconciling the `deploy` branch on hive against `main`, we discovered that an autonomous agent running on Mike's mac-mini deployment (`~/services/hive`) had been writing SKILL.md files directly into the running install's `skills/` directory, and an auto-commit cron was snapshotting the working tree to the shared `deploy` branch. The snapshot included a real `src/` bug fix alongside agent-authored skill content, an agent-edited shipped skill, orphan agent definition yamls, and customer business data (an xlsx forecast). The real fix was eventually cherry-picked to main as a surgical single-file pick; the rest of the working-tree contamination was left on `deploy` and is still there as of this writing.

Investigating further revealed that the current `skills/` tree in the hive core repo — the five workflows and thirteen skills documented in `2026-04-14-skills-system-design.md` §4.1 — is **itself the product of this same pattern running over an earlier iteration**. Those skills were not curated content Keepur deliberately wrote to ship. They arrived through silent accretion: agents authored SKILL.md files on earlier hives, the filesystem state got committed, the commits landed on `main`, and what looked like "content Keepur decided to ship" was actually retroactively-absorbed agent output that nobody had reviewed as a distribution-candidate.

This is not a hypothetical problem. It is a recurrent incident. The same failure mode has now happened twice: once quietly (creating the current shipped-skills tree) and once visibly (Mike's mac-mini auto-commits). The design as it stands — with `2026-04-14-skills-system-design.md` §5.2 origin category 1 "Shipped with Hive core" treated as a legitimate distribution path — has no mechanism to prevent a third occurrence.

The root cause is the absence of a clean ownership boundary between content the hive engine ships ("our code, our shape") and content the customer generates at runtime ("their data, their shape"). Skills in particular straddle this line because they are prose-with-instructions: code-like enough to ship in a tarball, data-like enough for an agent to author at runtime. The filesystem `skills/` path has been treated as both a delivery channel for Keepur-authored content and a working directory for agent writes, with nothing enforcing the partition, and the accretion we observed is the inevitable consequence of that conflation.

## 2. Goals

1. Eliminate the category of shipped-with-hive-core skills entirely. No skills in the tarball.
2. Define skill ownership as a three-category model — plugin-bundled, registry-installed, agent-authored — with physical layouts and mutation rules for each.
3. Partition the filesystem at runtime so agent writes and customer edits can only land in customer-owned paths. The hive engine tree remains in the shape it was shipped in.
4. Preserve the `2026-04-14-skills-system-design.md` §4.4 invariant that agents author skills via the filesystem Write tool, not via a special MCP authoring API.
5. Give every customer-owned skill free version control and audit history via an instance-local git branch that is never pushed and never participates in deploy orchestration.
6. Define an exit contract at the filesystem level: on service termination, the customer walks away with a specific subtree containing everything of theirs, and nothing else.
7. Handle the one-time migration of the two known existing deployments (dodi-hive, Mike's mac-mini) without losing content agents are actively using.
8. Establish the boundary and leave the registry-interaction details (CLI surface, registry file format, install/upgrade/discovery mechanics, default Keepur registry hosting, promotion pipeline) to a separate follow-on spec.

## 3. Non-Goals

- **Registry interaction mechanics.** This spec establishes *that* registry-installed skills are one of the three origins and *where* they land in the filesystem, but it does not define the registry protocol, the CLI surface, the publication workflow, the discovery UX, or the default Keepur registry hosting. Those are the scope of the follow-on registry spec.
- **Migration tooling as a reusable product.** The migration for existing deployments is a one-time concern for the two known hives. No reusable `hive migrate-legacy-skills` command needs to exist. Future customers install fresh and have nothing to migrate.
- **Mongo storage for skills.** Skills stay filesystem-native, consistent with `2026-04-14-skills-system-design.md` §4.4 and §9. The deferred Mongo migration listed as an open question in that spec is not triggered by this design — the ownership partition is what was actually needed, not a storage substrate change.
- **Promotion pipeline from customer-authored to published registry entries.** How an agent-authored skill on a customer's hive becomes a candidate for inclusion in the default Keepur registry is a real question, but it is a registry-side concern and belongs in the follow-on registry spec.
- **Changes to plugin MCP servers or plugin manifest format.** This spec treats plugin-bundled skills as a pre-existing category that continues to live in the plugin's own tree per `2026-04-14-skills-system-design.md` §6.1. Nothing in `2026-04-14-plugin-architecture-design.md` §5 (plugin definition and manifest) changes.

## 4. Principle

**Filesystem = what we ship, in the shape we shipped it. Customer-owned subtree = customer content the customer keeps on exit. Neither crosses over at runtime.**

This is the single principle every design decision in this spec reduces to. It is an exit contract, not a runtime convenience: on service termination, the customer receives their customer-owned subtree (and their Mongo data) as theirs to keep, and the hive engine tree is licensed content that goes away with the license. The principle is only defensible if it is enforced at runtime, so the rest of the spec is mechanisms for enforcement.

### 4.1 What this means for skills specifically

Skills are prose-with-instructions — code-like enough that the shipped ones would plausibly belong in the tarball, data-like enough that the agent-authored ones are customer content. The test for "should this skill live in customer space" is not "is it code-like" but "whose content is it, and who walks away with it on exit." An agent writing a SKILL.md on behalf of a customer produces customer content, regardless of code-likeness. A plugin author shipping a SKILL.md bundled with their plugin produces plugin-owned content, regardless of data-likeness.

### 4.2 What this means for the tarball

The hive core package declares the engine (`dist/`, runtime assets, package metadata) in its `files:` whitelist. It does **not** declare `skills/`. The `skills/` directory exists on running hives as pure customer state — the same way `hive.yaml`, `.env`, and `plugins/node_modules/` exist as customer state — without the package claiming it.

This is a change from the current tarball, which declares `skills/` and ships five workflows and thirteen skills inside it. §10 addresses the one-time migration consequences of removing the declaration.

### 4.3 What this means for an integration-core carve-out

`2026-04-14-plugin-architecture-design.md` §6.2 defines integration core (Google Workspace, Slack, Quo/OpenPhone, macOS Keychain, Linear as stopgap) — third-party systems hive ships as universal defaults, with their MCP servers and adapters bundled in core. The analogous question for skills is: are there skills so universal and so tightly bound to integration-core MCP servers that they should ship with the engine, as an integration-core category for skills?

**The answer is no.** There is no skill whose prose content is identical and equally correct across every hive that installs hive core. "Draft a reply via Gmail" is superficially universal, but the actual skill encoding that workflow depends on which agents exist on the hive, what voice they write in, and what the business context is. The Google Workspace MCP server is universal because "send a Gmail" is the same operation everywhere; a "draft a reply" skill is not, because the draft's voice and context are hive-specific. The triage of the current `skills/` tree (§10.3) is expected to confirm this — no skill in the current tree is universal enough to justify integration-core treatment; they are all either business-specific enough to drop, generic-enough-to-publish as registry entries, or salvageable-with-rewrite.

Skills have no integration-core category. Every skill is either plugin-bundled, registry-installed, or agent-authored. The tarball ships zero skills.

### 4.4 Plugins and skills have different threat models

The `2026-04-14-plugin-architecture-design.md` §7.2 establishes a relatively elaborate trust posture for plugins: curated registries as the paved path, explicit `--dev-mode` flag for raw URL installs, security warnings before untrusted installs, an optional `plugins.allowRawUrl: false` setting to disable raw-URL installs in production. That posture is justified by the plugin-specific threat model — plugins ship MCP servers, and MCP servers are the legitimate credential holders under the Honeypot architecture (#139). A malicious plugin can exfiltrate secrets directly; architecture alone cannot stop it; registry curation is the meaningful defense.

Skills have a narrower threat model. Per `2026-04-14-skills-system-design.md` §5.1, *"Under the Honeypot architectural guarantee, the worst outcome from a malicious skill is business-operational harm: wrong emails sent, wrong CRM records created, wrong Slack posts, budget burn. All recoverable. Credentials are not reachable from any agent a skill can be loaded into, because agents don't hold credentials — MCP servers do, and cloud-model-facing agents have no Keychain read entitlement."* A malicious skill can instruct an agent to do operational damage, but it cannot reach credentials.

Because of that narrower threat model, **the skills registry posture is dramatically simpler than the plugin registry posture**, and deliberately so. Skills can be installed from any git URL. There is no `--dev-mode` flag. There is no trust curation gate between "found a skill on GitHub" and "installed it on a production hive." The customer's responsibility is to read what they install; the architectural layer guarantees that the worst case from a bad read is recoverable operational harm, not credential compromise. The companion registry spec (`2026-04-15-skills-registry-design.md`) documents this posture in detail.

This asymmetry is intentional. If it ever stops being true — for example, if skills gain the ability to hold credentials or call MCP servers with elevated scope — the trust posture for skills must be revisited. Under the current architecture, the asymmetry holds.

## 5. The Three Origin Categories

`2026-04-14-skills-system-design.md` §5.2 defined a four-category origin model; this spec collapses category 1 (shipped with hive core) entirely and sharpens the definitions and layouts for the other three.

### 5.1 Plugin-bundled (immutable, plugin-owned)

Skills shipped inside a plugin. Live in the plugin's own install tree at `<plugin-dir>/skills/`, following the two-level layout `<plugin-dir>/skills/<workflow>/skills/<skill-name>/SKILL.md`. Owned by the plugin author. Immutable from the customer's perspective — the customer never edits a plugin's bundled skill file directly.

When the plugin upgrades, its entire tree (including `skills/`) is replaced atomically by `npm install` / `hive plugin upgrade`. The old plugin-bundled skills disappear; the new ones take their place. There is no diff-and-merge flow for plugin-bundled skills because the customer never owns them in the first place.

When the plugin is removed, its skills go with it. There are no orphan plugin skills in customer space, because plugin skills were never in customer space.

If a customer wants to change the behavior of a plugin-bundled skill, the paths are:

1. Don't install that plugin.
2. Have their agent author a replacement skill in customer space with the same name, which shadows the plugin-bundled one per §8 (name collision resolution).
3. Submit the change upstream to the plugin repo as a PR.

There is no fourth path. The customer cannot override a plugin-bundled skill by editing the file in the plugin tree — such an edit would be wiped on the next plugin upgrade, and the boot-time integrity check in §7 will flag the edit as drift before then.

### 5.2 Registry-installed (customer-owned, editable, upgrade-with-diff)

Skills installed from a skill registry via an explicit customer action. Live in customer space at `<instance-dir>/skills/`, following the same two-level layout as plugin-bundled skills (workflow/skills/name/SKILL.md). The customer owns the file from the moment of install. The customer can edit it freely.

On upgrade, the installed version is compared against the current registry version. If the customer has not modified the file since install, the upgrade applies cleanly. If the customer has modified the file, a diff is presented and the customer chooses keep / take / merge. Upgrades never clobber customer edits silently.

The mechanics of `hive skill add/list/upgrade/remove`, the registry repo layout, the default Keepur registry hosting, multi-registry resolution, and the diff-and-merge UX at upgrade time are specified in the companion spec `2026-04-15-skills-registry-design.md`. The short summary carried into this spec: a registry is an open-source git repository (the default is `github.com/keepur/hive-skills`) with a flat `skills/<skill-name>/` directory layout; `hive skill add` shallow-clones the repo and copies the target skill directory into `<instance-dir>/skills/<workflow>/skills/<skill-name>/`, where the runtime `<workflow>` grouping is read from the SKILL.md's `workflow:` frontmatter field (or defaults to the skill name when the field is absent); versioning uses git commit SHAs as the `base-version`; third-party registries are any git URL and run at the customer's own risk per §4.4. See the registry spec for the full CLI surface, the flat-to-nested projection rule, and the upgrade semantics.

What **is** specified by this spec:

- The filesystem location registry-installed skills land in: `<instance-dir>/skills/`.
- The metadata fields that identify a skill as registry-sourced (§6.2).
- The rule that registry-installed skills never land in the plugin tree or inside the hive engine tree.
- The principle that customer edits to an installed skill must survive subsequent upgrades (the diff-and-merge UX is the registry spec's problem to design, but the invariant it must preserve is this spec's).

### 5.3 Agent-authored (customer-owned, filesystem Write tool)

Skills written at runtime by an agent on the customer's hive, via the filesystem Write tool (consistent with `2026-04-14-skills-system-design.md` §4.4). Live in the same `<instance-dir>/skills/` tree as registry-installed skills, distinguished only by metadata. The customer owns the file the moment the agent writes it. The customer can edit it freely.

The authorship path has a **write guard** (§6.3) that captures provenance at write time: which agent authored the skill, when, and (optionally) a one-line reason the agent provides. The guard also enforces that SKILL.md writes land only inside `<instance-dir>/skills/` — an agent that attempts to write a SKILL.md to any path outside the customer-owned subtree receives a filesystem error. The physical partition does not rely on agent cooperation.

No dedicated MCP authoring tool is required. An agent writing `<instance-dir>/skills/<workflow>/skills/<name>/SKILL.md` via the regular Write tool is the supported authorship path. The `2026-04-14-skills-system-design.md` §4.4 invariant ("Agents have filesystem tools under `bypassPermissions` and can write new SKILL.md files directly. No special MCP tool is required.") is preserved.

### 5.4 What changed from the skills spec

| `2026-04-14-skills-system-design.md` §5.2 | This spec |
|---|---|
| 1. Shipped with Hive core | **Removed.** No skills in the tarball. `2026-04-14-skills-system-design.md` §5.2 is amended to drop this category. |
| 2. Shipped inside a plugin | **Kept, sharpened as §5.1** — explicitly immutable from customer's perspective; lives in plugin tree; never in customer space; replaced atomically on plugin upgrade. |
| 3. Installed from a skill registry | **Kept, sharpened as §5.2** — lives in customer space; editable; upgrade-with-diff invariant preserved even though mechanics are deferred. |
| 4. Agent-authored at runtime | **Kept, sharpened as §5.3** — lives in customer space alongside registry-installed skills; distinguished by metadata; write guard enforces the partition. |

## 6. Physical Layout

### 6.1 Directory structure

```
<instance-dir>/
├── dist/                                          ← hive engine, package-owned, read-only at runtime
├── node_modules/                                  ← engine dependencies, package-owned
├── package.json                                   ← package-owned
├── hive.yaml                                      ← customer configuration (not in tarball)
├── .env                                           ← customer secrets (not in tarball)
│
├── plugins/
│   └── node_modules/
│       ├── @keepur/hive-plugin-hubspot/
│       │   ├── plugin.yaml
│       │   ├── mcp-servers/
│       │   └── skills/                             ← plugin-bundled, immutable, upgraded with plugin
│       │       └── crm-workflows/
│       │           └── skills/
│       │               └── quarterly-review/
│       │                   └── SKILL.md
│       └── @keepur/hive-plugin-recall/
│           ├── plugin.yaml
│           ├── mcp-servers/
│           └── skills/
│               └── meeting-prep/
│                   └── skills/
│                       └── pre-call-brief/
│                           └── SKILL.md
│
└── skills/                                        ← CUSTOMER SPACE, not in tarball, not package-owned
    ├── morning-briefing/                          (registry-installed, editable)
    │   └── skills/
    │       └── morning-briefing/
    │           └── SKILL.md
    └── acme-reports/                              (agent-authored)
        └── skills/
            └── weekly-shipment-digest/
                └── SKILL.md
```

The `skills/` directory at the top level of `<instance-dir>` is **not** part of the hive core package. The package's `files:` whitelist does not include it. It exists entirely as customer state, the same way `hive.yaml` and `.env` do — present on running hives, never placed by the tarball.

### 6.2 Metadata on SKILL.md frontmatter

Every SKILL.md file in customer space carries origin metadata so the loader, upgrade flow, and promotion pipeline can distinguish between installed-from-registry and authored-at-runtime:

```yaml
---
name: morning-briefing
description: Aggregate all standup prep reports into a unified morning briefing
agents: [chief-of-staff]
workflow: morning-briefing          # runtime grouping; used by the installer's projection rule
origin:
  type: registry                    # or: agent-authored
  source: github.com/keepur/hive-skills
  base-version: 9c4f2a8b             # git commit SHA at install or last-accepted-upgrade
  base-tag: skills-v1.0              # optional: git tag pointing at base-version, if any
  installed-at: 2026-04-15T09:14:22Z
  modified: false                    # flips to true as soon as the customer edits the file
author:
  agent-id: chief-of-staff          # only for agent-authored skills
  authored-at: 2026-04-15T14:22:11Z
  reason: "weekly sales recap pattern for Acme"  # optional, one line
---

# Morning Briefing

<free-form prose: steps, decision points, output format>
```

The loader continues to read the `agents:` frontmatter as before (`2026-04-14-skills-system-design.md` §4.2); the `origin` and `author` fields are for upgrade and promotion logic, not for loading.

Plugin-bundled skills do **not** require this metadata — the plugin's own version, author, and install time already identify them, and a plugin-bundled SKILL.md can use the same frontmatter shape defined in `2026-04-14-skills-system-design.md` §4.2 without any extensions. If a plugin author does include `origin:` in a bundled SKILL.md, the loader ignores it.

### 6.3 Write guard for agent authorship

Agent writes to the filesystem via the Write tool pass through a filter in the skill-loader when the target path matches the SKILL.md shape under `<instance-dir>/skills/**`. The filter enforces:

1. **Path constraint.** A SKILL.md write must target a path under `<instance-dir>/skills/`. Writes outside that subtree are rejected with a filesystem error. An agent that attempts `Write(path="<repo>/src/skills/foo/SKILL.md", ...)` receives an error; `Write(path="<instance-dir>/skills/foo/skills/bar/SKILL.md", ...)` succeeds.
2. **Frontmatter capture.** If the SKILL.md is newly created (no prior file at the same path), the guard injects `origin.type: agent-authored`, `author.agent-id` (from the current agent session context), and `author.authored-at` (current timestamp). The agent does not need to supply these fields.
3. **Reason prompt (optional).** If the agent's invocation context includes a one-line reason field, the guard records it as `author.reason`. This is convention rather than requirement — agents that don't supply a reason still author skills successfully, with the field left blank.
4. **Git commit (see §7.2).** The write triggers an instance-local git commit capturing the change, with the agent-id as commit author and the reason as commit message.

The guard runs **on the skill-loader write path**, not on the SDK Write tool itself. An agent can still write any file anywhere else on the filesystem (within the `bypassPermissions` scope `2026-04-14-skills-system-design.md` §4.4 already grants); the guard only applies when the written path matches the skills directory shape. This keeps the invariant narrow and avoids blanket filesystem restrictions that would interfere with the agent's other legitimate tool use.

### 6.4 Loader scan paths

`src/agents/skill-loader.ts` scans, in order:

1. **Plugin-bundled skills.** For each installed plugin in the composition, scan `<plugin-dir>/skills/` following the two-level layout. This matches `2026-04-14-skills-system-design.md` §6.1.
2. **Customer-space skills.** Scan `<instance-dir>/skills/` following the same two-level layout.

Both scans produce skill entries in a single runtime index. The loader does not copy or materialize files; it reads from each source location directly. Plugin skills stay in the plugin tree; customer skills stay in `<instance-dir>/skills/`.

### 6.5 Loader scan path removed

The current loader scans `<repo>/skills/` as the primary source for shipped skills. **This path is removed.** The new tarball does not ship a `skills/` directory at the repo root; nothing inside the package tree is expected to contain SKILL.md files at load time. The loader change is a deletion, not a refactor — the existing plugin-bundled scan and the new customer-space scan together replace the removed shipped-skills scan.

## 7. Boot-Time Integrity Enforcement

### 7.1 Package manifest is the integrity boundary

The hive core package declares its files via the standard npm `files:` whitelist in `package.json`. Anything declared there is package-owned. Anything not declared is customer state. This is the boundary, and it is largely enforced by npm itself at install and update time.

The critical property: **the package's `files:` whitelist does not include `skills/`**. The tarball does not place anything there. On fresh install, `<instance-dir>/skills/` does not exist until the customer installs or authors a skill. On upgrade, npm leaves `<instance-dir>/skills/` alone because the package does not declare it.

### 7.2 Instance-local git branch for audit and version control

Each hive instance initializes a local git repository at `<instance-dir>` on first boot (if not already present). The repository has two branches, both local-only — **never pushed to any remote**, never used for deploy orchestration, never a source of truth for code shipping:

- **`installed`** — tracks whatever the current hive core package version placed on disk. This branch is rewritten by the upgrade process on each `npm install @keepur/hive@<version>` — it is a snapshot of the shipped state, regenerated from the tarball. Used by the boot-time integrity check in §7.3 to verify package content hasn't drifted.

- **`state`** — tracks `<instance-dir>/skills/` and other customer-writable paths. Commits are made automatically by the write guard (§6.3) when an agent writes a SKILL.md, with the agent-id as commit author and the agent's supplied reason (or an auto-generated fallback like `agent-authored: <skill-name>`) as commit message. Customer edits made outside the write-guard path (e.g. the customer directly edits `skills/morning-briefing/SKILL.md` via a text editor) are picked up on the next loader reload and committed with the human user as author. Never pushed. Exists only as local audit history.

The `state` branch gives us version control and an audit trail for customer-owned content without depending on Mongo or a custom versioning collection. `git log -- skills/<skill-name>` answers "who changed this skill and when" via standard tooling. `git blame` works. `git diff` between arbitrary points works. The cost is effectively zero — we get everything git already does.

**Important constraints on the `state` branch:**

- It is an audit-only artifact. Nothing depends on it being pushed anywhere, nothing reads it remotely, nothing uses it for deploy synchronization. If it is lost (disk failure, accidental `rm -rf .git`), the skills themselves are still present in the working tree and the hive continues to function; only the audit history is gone.
- It is not cryptographically signed or verified. If a malicious actor has write access to the filesystem, they can rewrite the branch history. This is audit, not security.
- It must never cover engine-owned paths. The `state` branch commits only touch files inside allowlisted customer-writable paths (§7.4). A commit that somehow picked up a change under `dist/` would be a bug in the write guard — the boot-time integrity check in §7.3 catches this independently as a package drift.

The design lesson from KPR-29: **do not conflate per-instance audit state with shared deploy orchestration.** The current `deploy` branch on hive is serving as both ("auto-commit on deploy" plus "what instances pull"), and the mingling is the root cause of the incident. The `state` branch is strictly per-instance and strictly local.

### 7.3 Boot-time check

On service startup, the hive engine verifies:

1. **Package integrity.** For each path declared in the hive core package manifest, verify the file exists and its content matches the snapshot recorded at install time (either via a per-file hash written to `<instance-dir>/.hive/installed-snapshot.json` by the package install hook, or by comparing the working tree against the `installed` git branch at HEAD). If any package-owned file is missing or has been modified, **refuse to start** and log the drift with enough detail for the operator to remediate. This catches "an agent or a human accidentally modified engine code" — which, if undetected, would undermine the entire exit contract.

2. **Allowlisted customer-writable paths.** Any file outside the package-declared paths is acceptable **as long as it lives within an allowlisted customer-writable path**: `<instance-dir>/skills/`, `<instance-dir>/hive.yaml`, `<instance-dir>/.env`, `<instance-dir>/plugins/node_modules/**`, `<instance-dir>/.hive/**` (for instance-local metadata), and a small set of others as needed. A file at a path that is neither package-owned nor allowlisted is logged as a drift warning on startup (but does not refuse to start — this is discovery, not enforcement, because blocking startup over an unknown stray file would be too brittle).

The check makes the exit contract runtime-enforceable. "Filesystem is ours, customer subtree is theirs" stops being a convention and becomes a guarantee: the hive will refuse to run if the engine tree has been modified, and it will flag any filesystem state outside the allowlisted customer-writable paths so drift cannot accumulate silently the way it did on Mike's mac-mini.

### 7.4 Explicitly not enforced

- The contents of `<instance-dir>/skills/` are not integrity-checked. The customer can put anything there that conforms to the SKILL.md loader shape. Malformed files are skipped with a loader warning and do not affect boot.
- Plugin-bundled skills are not integrity-checked by the core integrity check. The plugin install path is responsible for its own integrity; core does not second-guess plugins beyond the compatibility-version check in `2026-04-14-plugin-architecture-design.md` §7.4.
- The `state` git branch is not verified. If it is corrupt or missing, the hive logs a warning and continues running; audit history is degraded but functionality is preserved.

## 8. Name Collision Resolution

When the loader scans plugin trees (§6.4 step 1) and customer space (§6.4 step 2) and finds the same skill name in both — for example, `hive-plugin-hubspot` ships a `quarterly-review` skill under `crm-workflows/`, and the customer's agent has authored a `quarterly-review` skill under the same `crm-workflows/` path in `<instance-dir>/skills/` — the precedence is:

**Customer space wins. Collision is logged as a warning on boot.**

This matches the Unix `PATH` convention that local overrides system, and the Docker layer convention that later layers shadow earlier ones. The customer should be able to override a plugin-bundled skill's behavior without having to fork the plugin. A warning on boot gives the customer visibility ("your `quarterly-review` skill in customer space is shadowing the version from `hive-plugin-hubspot`") without breaking anything.

Collisions **between two customer-space skills** with the same name are a different category — they indicate a skill naming conflict the customer needs to resolve manually, and the loader errors out on boot with a clear message identifying the conflicting paths.

Collisions **between two plugin-bundled skills from different plugins** follow `2026-04-14-skills-system-design.md` §6.1: logged as warning, first-loaded plugin wins, order determined by the plugin composition record.

## 9. Exit Contract

On service termination (customer stops their hive subscription, we stop supporting a deployment, or the customer moves off hive entirely), the disposition of content is:

1. **Mongo collections** are the customer's data. Customer retains access (their MongoDB runs on their infrastructure) or receives an export. The relevant collections per `CLAUDE.md`: `agent_definitions`, `agent_definition_versions`, `memory`, `memory_versions`, `agent_sessions`, `model_overrides`, `devices`, `agent_callbacks`, `contacts`, plus any instance-specific collections. These are portable as JSON — the customer can read them without any hive tooling.

2. **`<instance-dir>/skills/` as a filesystem subtree** is the customer's customer-space content. Customer retains access (it is on their hardware) or receives it as a zip archive or as a git bundle of the `state` branch. Contains registry-installed skills, agent-authored skills, and any local modifications to either. Can be read as plain markdown files without any hive tooling. Includes the `state` branch's git history as audit trail.

3. **`<instance-dir>/hive.yaml` and `<instance-dir>/.env`** are customer configuration. Retained by the customer.

4. **`<instance-dir>/plugins/node_modules/**`** are licensed plugin content. Disposition depends on each plugin's own license, not on hive's exit contract. Plugin authors are responsible for their own exit story. Hive core makes no claim on plugin content.

5. **Hive core engine (everything under package-declared paths: `dist/`, `node_modules/`, `package.json`, etc.)** is Keepur-licensed content that goes away with the license. It is not part of the customer handover.

The physical separation at the filesystem level makes this trivially enforceable. There is no extraction tool, no export pipeline, no selective handover. The customer's content already lives in a distinct subtree, and the termination process simply removes the Keepur-licensed pieces while leaving the customer-owned pieces in place. A customer who walks away with a tarball of their `<instance-dir>` (minus Keepur-declared paths) and a mongodump has everything they need.

## 10. Migration for Existing Deployments

The two known existing deployments — `dodi-hive` (in `~/services/hive` on the dodi-hive host) and Mike's mac-mini (in `~/services/hive` on Mike's mac-mini host) — were running an earlier version of hive core that declares `skills/` inside its tarball. Upgrading them to the new version has consequences that need one-time handling. **Future customers, who will install `@keepur/hive@<new-version>` fresh, have nothing to migrate.**

### 10.1 What npm does on upgrade

When `npm install @keepur/hive@<new-version>` runs on a deployment that previously had `@keepur/hive@<old-version>`:

- Files declared in the old manifest and still declared in the new manifest are **overwritten** with new content (normal upgrade).
- Files declared in the old manifest but not in the new manifest are **removed** (npm's cleanup of previous package state).
- Files never declared in any package manifest (customer state, agent writes, local modifications outside tracked paths) are **left alone** — npm does not know they exist.

For the `skills/` tree specifically: every SKILL.md that was part of the old tarball's `skills/` declaration gets removed on upgrade. Every SKILL.md that was written by an agent post-install and was never part of any tarball gets preserved. This is the decisive property that makes the migration simpler than it first appeared.

### 10.2 Impact on known deployments

**Mike's mac-mini:**

| Path | In old tarball? | Upgrade disposition |
|---|---|---|
| `skills/agent-builder/**` | Yes | Removed by npm. Re-installable from the default Keepur registry via `hive skill add` if desired. |
| `skills/inbound-triage/**` | Yes | Removed. Re-installable. |
| `skills/jasper-reports/**` | Yes | Removed. Re-installable. |
| `skills/morning-briefing/**` | Yes — and `SKILL.md` has local agent modifications from commit `8244475` | **Removed along with local edits unless pre-upgrade backup is taken.** This is the one edge case that needs manual handling on this deployment. |
| `skills/project-tools/**` | Yes | Removed. Re-installable. |
| `skills/ai-analyst/**` | No — agent-authored on Mike's hive via commit `78d9de7` | **Untouched by npm. Survives upgrade natively.** The new loader picks it up from the same path and treats it as agent-authored customer-space content. The agent that wrote it continues to have access. |

**dodi-hive:** unverified, but expected to be entirely tarball-origin content with no local edits. Needs a one-time audit before upgrade to confirm. If the expectation holds, `npm install` removes everything in `skills/`, and the dodi-hive operator re-installs the desired subset from the default registry. If there are surprises — local edits, agent-authored additions — they are handled the same way as on Mike's mac-mini.

### 10.3 Keepur-side publication (one-time, before shipping the new version)

Before the new hive core version ships, the current `skills/` tree in the hive core repo is triaged skill-by-skill. Each of the five workflows and thirteen skills gets one of three dispositions:

1. **Publish to the default Keepur registry.** Skill is reviewed for the first time as a distribution candidate, and if it passes that review, it is published as a registry entry at version 1.0.0. This is the path for skills that, after honest review, are worth offering to every hive.

2. **Drop.** Skill is hive-specific leftover agent output that should not have been in the tarball and is not worth shipping to other hives. It disappears from the new version with no replacement.

3. **Rewrite before publishing.** Skill is salvageable but the current content is too specific to earlier Keepur internal use, or encodes assumptions that no longer apply. Keepur rewrites it, publishes the rewrite to the default registry at version 1.0.0.

The triage is per-skill, manual, happens once, and produces the initial content of the default Keepur registry. The expected outcome: some skills publish at version 1.0.0 identical to their current content, some publish rewritten, some drop. No skill is grandfathered as "it was in the tarball before so we ship it unchanged without review."

### 10.4 Migration steps per deployment

The migration is a one-time manual operation performed by Keepur against the two known deployments. There is no reusable `hive migrate-legacy-skills` command; future customers install fresh and skip this entirely.

**Pre-upgrade audit (per deployment):**

1. On the running deployment, enumerate `skills/**/*SKILL.md`. For each file, determine via content hash or diff: was it part of the old tarball, and has it been modified since install?
2. For any file identified as "in old tarball + locally modified," copy it to a scratch location outside the package path (e.g. `<instance-dir>/skills-backup-2026-04-15/`). This preserves the modifications before npm wipes them.
3. For any file identified as "not in old tarball" (agent-authored), no action needed — npm will leave it alone on upgrade.

For Mike's mac-mini, the audit is expected to produce exactly one file to back up: `skills/morning-briefing/SKILL.md` (the edit from commit `8244475`). For dodi-hive, the audit is expected to produce zero files, pending verification at audit time.

**Upgrade:**

1. Run `npm install @keepur/hive@<new-version>` on the deployment.
2. npm removes the declared-in-old-but-not-new files; the tarball-origin `skills/` content disappears from the filesystem.
3. The hive starts up. The new loader finds any agent-authored survivors (e.g. Mike's `skills/ai-analyst/`) and indexes them. Former-shipped skills are not in the loader index until re-installed.

**Post-upgrade (per deployment):**

1. For each shipped skill the customer wants to keep using, run `hive skill add <name>` to pull the current version from the default Keepur registry (mechanics TBD per the registry spec).
2. For any backed-up locally-edited shipped skills, restore the edits. Two paths:
   - **(a)** Install the registry version via `hive skill add`, then re-apply the local diff as a customer edit. The file flips to `origin.modified: true`, and the next `hive skill upgrade` will surface the diff against the then-current registry version for review.
   - **(b)** Write the backed-up content into customer space as an agent-authored replacement with the original skill name. This treats the edited version as the customer's own content going forward, independent of any future registry upgrades to the base skill.
   Path (a) preserves the upstream-tracking relationship; path (b) severs it. For Mike's `morning-briefing` edit, path (a) is probably appropriate — the customer is still interested in future upgrades to the underlying skill.
3. Verify the deployment is fully functional, then remove the scratch backup location.

### 10.5 First-boot upgrade notice

If an operator upgrades a deployment without reading the release notes — which is a realistic failure mode and one we should design against — their agents will silently lose access to skills that were previously in the tarball. To surface this:

On first boot after upgrade, the hive engine checks whether a previous-version package snapshot exists that recorded tarball-shipped skill paths (from the old version's `installed-snapshot.json`, before it gets overwritten by the new version's snapshot). If any of those paths were present before the upgrade and are no longer present in the running `<instance-dir>/skills/` tree, the engine emits a one-time startup notice:

```
Your previous version of hive shipped the following skills in its tarball:
  - morning-briefing
  - inbound-triage
  - jasper-reports
  - project-tools
  - agent-builder

These are no longer part of the hive core package. You can re-install any of
them from the default Keepur registry with:

  hive skill add <name>

Agent-authored skills you or your agents wrote on this hive are unaffected and
continue to work. This notice only appears once. See
docs/specs/2026-04-15-skills-customer-space-design.md for details on the new
skill ownership model.
```

This is a convenience notice, not a migration wizard. It asks no questions and takes no automatic action. Its only purpose is to make the change visible so the operator knows to run `hive skill add` for anything they were relying on. After it emits once, it records the emission in `<instance-dir>/.hive/` and does not emit again on subsequent boots.

## 11. What This Spec Does Not Specify (Deferred)

### 11.1 Registry interaction details

This spec treats "registry-installed" as an origin category with a defined filesystem landing zone (`<instance-dir>/skills/`) and a defined set of frontmatter metadata fields (`origin.source`, `origin.base-version`, etc.). The concrete mechanics — CLI shape, registry repo layout, fetch algorithm, flat-to-nested projection rule, multi-registry resolution, sidecar handling, upgrade semantics, offline mode — are specified in the companion spec `2026-04-15-skills-registry-design.md`, which is being written alongside this one rather than as a later follow-on.

The short architectural summary, carried into this spec so the ownership model is complete without requiring a cross-spec read:

- **A registry is an open-source git repository.** Not a hosted service, not a custom package format, not a bespoke protocol. The default is `github.com/keepur/hive-skills`. Any git URL (https, ssh, or `file://`) can serve as a registry.
- **Repo layout is flat per-skill**, following the convention established by `anthropics/skills` and other comparable repos: `skills/<skill-name>/SKILL.md` at the top level, with optional sidecar files (`scripts/`, `references/`, `assets/`) in the same directory.
- **Installation copies the entire skill directory** (SKILL.md plus sidecars) into `<instance-dir>/skills/<workflow>/skills/<skill-name>/`, where `<workflow>` is read from the SKILL.md's `workflow:` frontmatter field or defaults to the skill name when the field is absent.
- **Versioning is git commit SHA** recorded as `base-version`, with optional human-meaningful git tags as reference points. No per-skill semver, no dependency resolution, no version-constraint algorithm.
- **Third-party registries are any git URL.** No trust curation, no dev-mode flag, customer's own risk per §4.4.
- **Upgrade is a git fetch + SHA compare + diff-if-modified** — always prompts the customer when their installed version has local edits, never clobbers silently.

**Genuinely deferred** (not covered by either this spec or the registry spec, left for future work):

- **Discovery UX beyond basic CLI listing.** A web-browser interface for browsing available skills, search by capability tag, recommendations, etc. The registry repo's GitHub surface is the discovery surface for now — contributors and customers alike browse it via GitHub.
- **Promotion pipeline from agent-authored customer-space to the default Keepur registry.** How an agent-authored skill becomes a candidate for inclusion — pattern detection across instances, review queue UI, automated PR generation from `<instance-dir>/skills/` into the registry repo. For now, promotion is "submit a PR to the registry repo manually," using GitHub's native review flow. Anything smarter is future work.
- **Cross-fleet analytics.** Vendor-side visibility (Keepur looking across all hives) into which skills are being authored, installed, or used. Out of scope for this round.
- **Whether plugin-bundled skills can also be published as standalone registry entries**, so a customer could install one of a plugin's bundled skills without installing the whole plugin. The tradeoff is convenience (customer gets just the skill they want) vs. coherence (plugin-bundled skills are written assuming the plugin's MCP servers are present). Deferred to the registry spec's follow-on rounds.

### 11.2 Mongo-native skills (not planned)

The `2026-04-14-skills-system-design.md` §9 deferred question about migrating agent-authored skills to Mongo is not revisited by this spec. Filesystem remains the authoritative storage for all customer-space skills, consistent with the §4.4 write-tool-based authorship model. The §9 deferral condition ("if filesystem storage turns out to have lifecycle problems") has not been triggered — the problems we observed were ownership partition problems, not storage substrate problems, and the partition plus the instance-local audit branch in §7.2 address them fully.

If at some future point we need cross-instance query capabilities over skills (for fleet-wide curation, analytics, or promotion pattern detection across all customer hives), the right mechanism is a separate metadata index in Mongo — pointing at filesystem content rather than replacing it — not a migration of the content itself. That is a follow-on concern for the registry spec and beyond, not part of this spec.

### 11.3 Team layer and multi-agent skill sharing

`2026-04-14-skills-system-design.md` §4.2's `agents:` frontmatter field already handles per-agent visibility of customer-space skills. Multi-agent sharing within a hive is already solved by that mechanism. Cross-hive sharing (one customer's hive sharing skills with another customer's hive, without going through a registry) is not addressed here — the model is "registries are the cross-hive channel." If that turns out to be wrong, it is a registry-spec concern.

## 12. Amendments to Other Specs

### 12.1 `2026-04-14-skills-system-design.md`

- **§5.2 (origin categories):** amend to remove category 1 ("Shipped with Hive core"). The remaining three categories are re-numbered and their definitions are cross-referenced to §5 of this spec: "See `2026-04-15-skills-customer-space-design.md` §5 for the current ownership model."
- **§6 (What Changes in Code):** §6.1 "Plugin-bundled skills" is unchanged — this spec preserves the plugin-bundled loader scan. §6.2 "Hot reload on SIGUSR1" is unchanged and continues to apply to both plugin and customer-space skills. Add a new subsection §6.3 "Customer-space skills" that describes the write guard (§6.3 of this spec), the customer-space scan path (§6.4 of this spec), and the removal of the old `<repo>/skills/` scan (§6.5 of this spec).
- **§7 (CLI Surface):** move from "Reserved, Not Built" to "Specified in the follow-on registry spec." `hive skill add/list/upgrade/remove` are now load-bearing and are part of the registry spec's scope. Update the section framing but leave the CLI shape itself for the registry spec to finalize.
- **§8 (Agent-Authored Skill Promotion):** the per-hive promotion model (beekeeper reads, flips `agents:` frontmatter, SIGUSR1 reload) is preserved as-is. Cross-instance promotion to the default Keepur registry is deferred to the registry spec. Add a cross-reference noting that this spec moves agent-authored skills into `<instance-dir>/skills/` (customer space) rather than `<repo>/skills/` (package space).
- **§9 (Open Questions Deferred):** the "Mongo storage for agent-authored skills" item is still deferred; this spec documents that the deferral condition has not been triggered. Add a cross-reference.

### 12.2 `2026-04-14-plugin-architecture-design.md`

- **§4.1 (Hive is opinionated):** unchanged. Opinionation happens at the default Keepur registry level (§10.3 of this spec) rather than at tarball-contents level, which is consistent with the existing principle ("curation is part of the product") just moved from shipped-skills to curated-registry.
- **§6.2 (Integration core):** unchanged. The integration-core carve-out continues to apply to Google, Slack, Quo, Keychain, and Linear as stopgap. This spec's §4.3 explicitly notes that there is no integration-core category for skills.
- **§7.1 (Plugins live outside the core repo):** add a paragraph noting the parallel rule for skills: *"The same principle applies to skills: the core `@keepur/hive` npm tarball also ships zero skills in its `files:` whitelist. Skills arrive via plugin-bundled content (inside plugin tarballs), registry install (customer-initiated), or agent authorship (runtime, via the filesystem Write tool). See `2026-04-15-skills-customer-space-design.md` for the full ownership model and `2026-04-15-skills-registry-design.md` for the registry interaction mechanics. Note that the skills registry posture is deliberately simpler than the plugin registry posture described in §7.2 — skills have a narrower threat model and do not require the same trust-curation gate. Cross-reference: skills-customer-space-design §4.4."*
- No other sections affected. The plugin manifest (§5.1) already includes a `skills/` subdirectory in the plugin bundle, and §6.1 of the skills spec already specifies that the loader scans it. Both continue to apply unchanged.

### 12.3 KPR-29

The Linear ticket "Design agent-on-deploy commit workflow — isolate src fixes from skill-state auto-commits" should be updated to:

- Point at this spec as the resolution of the design question it raised.
- Drop the three-option list in the "Options to consider" section — the options are superseded by this spec's unified model.
- Move to "In Review" once this spec reaches spec-review stage, and close once this spec is approved and the implementation plan is written.

## 13. Implementation Steps (Outline)

This spec is not an implementation plan — the full plan will be written separately, after the spec is approved. As an outline of the work that falls out of this spec:

1. **Package manifest change.** Remove `skills/` from the hive core package's `files:` whitelist in `package.json`. Remove the `skills/` directory from the hive core repo (after the Keepur-side publication step in §10.3 is complete and the surviving skills are safely in the default registry). Add an `installed-snapshot.json` write to the package's postinstall / install hook so the boot-time integrity check (§7.3) has something to verify against.

2. **Loader changes** (`src/agents/skill-loader.ts`):
   - Remove the scan of `<repo>/skills/` (§6.5).
   - Add the scan of `<instance-dir>/skills/` (§6.4).
   - Keep the existing plugin-tree scan per `2026-04-14-skills-system-design.md` §6.1.
   - Implement the write guard (§6.3) as a filter on the SKILL.md write path.

3. **Instance-local git audit branch** (§7.2):
   - Initialize `<instance-dir>/.git` on first boot if not already present.
   - Configure `installed` and `state` branches.
   - Wire the write guard to commit on each SKILL.md write, with agent-id as author and reason as commit message.
   - Periodically reconcile outside-write-guard changes (customer hand-edits) into the `state` branch on loader reload.

4. **Boot-time integrity check** (§7.3):
   - Verify package-declared files against `installed-snapshot.json` at startup.
   - Walk the filesystem for files outside package-owned and allowlisted customer-writable paths; log as warnings.
   - Refuse to start on package integrity failure; continue (with warnings) on allowlist drift.

5. **First-boot upgrade notice** (§10.5):
   - Check for a previous-version snapshot at first-boot-after-upgrade.
   - Emit the one-time notice listing skills that were shipped in the old version but are missing from the new installation.
   - Record the emission so it does not repeat.

6. **Migration execution** (§10, one-time, manual):
   - Run the pre-upgrade audit on dodi-hive and Mike's mac-mini.
   - Perform the Keepur-side triage and registry publication of the current `skills/` tree.
   - Execute the upgrades and the post-upgrade `hive skill add` re-install steps.
   - Restore Mike's `morning-briefing` local edit via path (a) from §10.4.

7. **Spec amendments** (§12):
   - Update `2026-04-14-skills-system-design.md` per §12.1.
   - Update `2026-04-14-plugin-architecture-design.md` §7.1 per §12.2.
   - Update KPR-29 per §12.3.

Steps 1–5 can proceed in parallel with the follow-on registry spec. Step 6 depends on the registry being operational (the post-upgrade `hive skill add` step needs a working registry and CLI). Step 7 is a small documentation task and can land with the main implementation PR.

## 14. Acceptance Criteria

This spec is done when:

1. The exit contract principle (§4) is explicitly stated and every subsequent section derives from it.
2. The three origin categories are defined with physical layouts and mutation rules (§5), replacing the four-category model in `2026-04-14-skills-system-design.md` §5.2.
3. The filesystem partition (§6) and the boot-time integrity check (§7) together make "filesystem is the shape we shipped it, outside customer space" a runtime guarantee rather than a convention.
4. The instance-local audit branch (§7.2) delivers free version control and audit trail for customer-owned skills without depending on Mongo or a custom versioning collection, and without any orchestration role that could recreate the KPR-29 incident.
5. The exit contract (§9) is physically realizable without any extraction tooling — the customer's content is already in a distinct subtree at termination time.
6. The migration for the two known existing deployments (§10) is specified precisely enough that it can be executed without further design work, and the common case (no local edits to shipped skills) requires zero custom tooling.
7. The boundary between this spec and the forthcoming registry spec (§11.1) is clear enough that registry work can begin without re-litigating any ownership question established here.
8. The amendments to the two existing specs and KPR-29 (§12) are scoped and can be applied surgically.
