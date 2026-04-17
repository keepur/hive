# Phase 1: Plugin Architecture, Skills Registry Seed, and Skill Migration

**Status:** Draft
**Author:** Mokie + Claude (brainstorm session 2026-04-16)
**Issue:** #156 (Phase 1: Plugin architecture + skills registry completion)
**Related:**
- `2026-04-14-plugin-architecture-design.md` — locked plugin architecture spec. This spec implements the thin MVP subset.
- `2026-04-15-skills-registry-design.md` — locked skills registry spec. This spec creates the default registry and seeds it.
- `2026-04-15-skills-customer-space-design.md` — ownership model for agent-authored vs. plugin-bundled vs. registry-installed skills.
- `2026-04-15-mvp-readiness-epic.md` — Tracks 6 (plugin arch), 7 (skills registry), 8 (registry content).
- KPR-30 — revisit agent-created skills, ensure persistence in customer space.

---

## 1. Problem

Phase 0 (#148) shipped the "Hello World" experience: install, init, Chief of Staff in Slack. Three gaps remain before customers can expand their hive beyond CoS:

1. **`hive plugin add` doesn't work end-to-end.** The CLI runs `npm install` into `<hiveHome>/plugins/`, but the plugin loader resolves `<hiveHome>/plugins/<name>/plugin.yaml` — no `node_modules/` segment. The installed package is invisible to the runtime.

2. **The default skills registry has no content.** `config.ts` and `registry-resolver.ts` already point at `github.com/keepur/hive-skills` as the built-in default, but the repo doesn't exist yet. `hive skill add` has nowhere to fetch from.

3. **Agent-created skills are trapped in the wrong location.** PR #154 restored 5 skill suites (morning-briefing, inbound-triage, agent-builder, jasper-reports, project-tools) to `plugins/dodi/skills/`, making them plugin-bundled (immutable from customer perspective). But these were agent-authored on dodi-hive over months. Agents can't evolve them without creating disconnected shadow copies in customer space.

## 2. Goals

1. Make `hive plugin add @scope/pkg` install, validate, and activate a plugin end-to-end — with zero manual steps after the command finishes.
2. Create the default Keepur skills registry with seed content so `hive skill add <name>` works out of the box.
3. Migrate agent-authored skills out of `plugins/dodi/skills/` and into customer space where agents own them. Cement the principle that agent-created skills are always customer-space.

## 3. Non-Goals

- **Plugin JSON registry / curated distribution.** The full registry model from `plugin-architecture-design.md` §7.2 (JSON manifest file, `--dev-mode` gate, trust-curation flow) is deferred. For now, npm scoped packages serve as the registry — `@keepur/hive-plugin-*` requires Keepur npm org membership to publish, which is the trust boundary.
- **`hive_composition` DB writes.** The spec envisions a Mongo composition record updated on plugin/skill install. Deferred — filesystem + `hive.yaml` are the source of truth for now.
- **`hive plugin upgrade`.** Install and remove are sufficient for MVP. Upgrade is `remove` + `add`.
- **Full 13-skill triage.** Triage and publish what passes review cleanly. The rest can follow.
- **Multi-registry collision handling.** Not needed until a second skill registry exists.
- **Plugin-bundled skills as a general distribution mechanism.** Plugin-bundled skills should be rare and genuinely coupled to a plugin's MCP server (e.g., "how to use the dodi-ops quirks"). They are not for agent-evolvable content.

## 4. Design

### 4.1 Track 6 — Plugin Architecture (Thin)

#### 4.1.1 Loader Path Resolution

`plugin-loader.ts` currently resolves: `<rootDir>/plugins/<name>/plugin.yaml`

Updated resolution order (first match wins):
1. `<rootDir>/plugins/node_modules/<name>/plugin.yaml` (npm-installed — new)
2. `<rootDir>/plugins/<name>/plugin.yaml` (in-tree dev fallback — existing behavior)

The first path that exists wins. This handles both npm-installed plugins (scoped or unscoped: `@keepur/hive-plugin-google`, `hive-plugin-recall`) and the existing in-tree `plugins/dodi/` layout during the transitional period. Scoped package names contain a `/` (e.g., `@keepur/hive-plugin-foo`), which Node's `path.resolve` handles correctly within the `node_modules/` tree.

`agent-runner.ts` gets the same dual-lookup for MCP server spawn paths. Today it resolves two paths (line 617–620):
- `devPath`: `<DIST_DIR>/plugins/<name>/<entry>` (compiled from source)
- `npmPath`: `<hiveHome>/plugins/<name>/dist/mcp/<entry>` (no `node_modules/` — only works for in-tree plugins like `plugins/dodi/`)

Updated to three paths, checked in order (first that exists wins):
1. `<DIST_DIR>/plugins/<name>/<entry>` (dev build from source — unchanged)
2. `<hiveHome>/plugins/node_modules/<name>/dist/mcp/<entry>` (npm-installed — new)
3. `<hiveHome>/plugins/<name>/<entry>` (in-tree fallback — current `npmPath` becomes this)

**Note: this intentionally inverts the current priority.** Today the code checks `npmPath` before `devPath` (`existsSync(npmPath) ? npmPath : devPath`). The new order puts dev builds first so source-tree plugins always take precedence during development — if you're actively building a plugin from source, the dev build should win over any stale npm-installed copy.

The `LoadedPlugin.dir` field already carries the resolved absolute path from the loader, so downstream code that reads `plugin.dir` (e.g., `registerPluginCommands`) needs no changes. The agent-runner path resolution is independent of the loader — it constructs its own paths from the plugin name and server entry. Both must be updated.

#### 4.1.2 CLI: `hive plugin add`

```
$ hive plugin add @keepur/hive-plugin-google
Installing @keepur/hive-plugin-google...
✓ Installed (v0.1.0, hiveApi ^1.0.0)
✓ Updated hive.yaml
✓ Restarting hive... done
@keepur/hive-plugin-google is now active.
```

Flow:

1. `npm install <target>` in `<hiveHome>/plugins/` (creates `package.json` if missing, same as today).
2. **Post-install validation:** Resolve the installed package directory under `plugins/node_modules/<target>/`. Check for `plugin.yaml`. If missing → `npm uninstall <target>`, exit non-zero: `"Not a valid hive plugin — no plugin.yaml found."` If present, read `hiveApi` field and run the existing `isHiveApiCompatible()` check against core's version. If incompatible → `npm uninstall`, exit non-zero: `"Plugin requires hiveApi <range> but this hive is <version>."`.
3. **Update `hive.yaml`:** Read `hive.yaml` via the `yaml` library (`parseYaml`/`stringifyYaml` — same `readConfig`/`writeConfig` pattern `src/cli/registry.ts` uses). If the `plugins:` array does not exist, create it as an empty array. Append the package name. Write back. Note: the current `readConfig`/`writeConfig` in `registry.ts` uses `stringifyYaml` which does not preserve comments. This is acceptable for now — `hive.yaml` comments are rare in practice. A shared `readConfig`/`writeConfig` utility should be extracted from `registry.ts` so both `plugin.ts` and `registry.ts` use the same code (implementation detail, not spec).
4. **Restart detection:** Check if the LaunchAgent is loaded via `launchctl list <service-label>`. Service label is `com.hive.<instanceId>.agent`, where `instanceId` is read from `hive.yaml`. The `hiveHome` path is already resolved in `src/paths.ts`. If loaded → `launchctl kickstart -k gui/<uid>/<label>`. If not loaded → print `"Start hive to activate the plugin."` LaunchAgent restart is a full process restart (`launchctl kickstart -k` kills and relaunches), so the new process re-reads `hive.yaml` from scratch via `loadAppConfig()` in `src/config.ts` — no stale-config risk.
5. Print summary.

Error handling: any failure at steps 1–3 is atomic — npm install is rolled back, `hive.yaml` is not modified. Step 4 failures (restart) are warnings, not errors — the plugin is installed and will load on next manual start.

#### 4.1.3 CLI: `hive plugin remove`

Mirror of `add`:

1. `npm uninstall <target>` in `<hiveHome>/plugins/`.
2. Remove the package name from `hive.yaml plugins:`. If the name is not present in the array (e.g., a legacy in-tree plugin that predates `hive.yaml` tracking), skip the removal silently — the npm uninstall is still the primary action.
3. Restart LaunchAgent (same detection logic as `add`).

#### 4.1.4 CLI: `hive plugin list`

**Rewritten from current code** (current `plugin list` reads `plugins/package.json` dependencies — switching to `hive.yaml` as the source of truth to match `add`/`remove`).

Reads the `plugins:` array from `hive.yaml`. For each entry, resolves the on-disk directory using the same dual-lookup as the loader (`node_modules/<name>/` then `<name>/`). Reads `plugin.yaml` to extract version and `hiveApi` range. Prints the list with a warning for any entry that exists in config but not on disk (or vice versa).

```
$ hive plugin list
Installed plugins:
  @keepur/hive-plugin-google  v0.1.0  (hiveApi ^1.0.0)
  dodi                        v0.1.0  (hiveApi ^1.0.0)  [in-tree]
```

Edge case: legacy plugins that exist on disk but were never added to `hive.yaml` (e.g., `plugins/dodi/` predates the `hive.yaml` tracking). `plugin list` only shows `hive.yaml` entries. The in-tree plugin still loads at runtime (the loader reads `appConfig.plugins` which includes `dodi` from the existing config), but it won't appear in `plugin list` unless the `plugins:` array in `hive.yaml` includes it.

#### 4.1.5 Core Manifest

`src/plugins/api-version.ts` currently hardcodes `HIVE_PLUGIN_API_VERSION = "1.0.0"`. This stays as-is — the constant is the single source of truth consumed by the loader. Additionally, add a `hiveApi` field to the root `package.json` for informational purposes (npm metadata, tooling). The loader reads the constant, not `package.json` at runtime.

### 4.2 Track 7 — Skills Registry Seed

#### 4.2.1 Create the Default Registry

Create `github.com/keepur/hive-skills` as a public repo with the flat layout specified in `skills-registry-design.md` §5:

```
hive-skills/
├── README.md
├── skills/
│   ├── morning-briefing/
│   │   └── SKILL.md
│   ├── agent-builder/
│   │   └── SKILL.md
│   └── <other survivors>/
│       └── SKILL.md
```

#### 4.2.2 Seed Content

Triage the 5 skill suites currently in `plugins/dodi/skills/`. Each suite gets one of three dispositions:

1. **Publish** — generalizable beyond dodi, worth offering to every hive. Publish to the registry with `workflow:` frontmatter set.
2. **Rewrite then publish** — salvageable but too dodi-specific in current form. Rewrite to be generic, then publish.
3. **Drop** — too business-specific to generalize. Does not go in the registry. Stays as agent-authored customer-space content on dodi-hive only.

Expected outcomes (subject to triage review):

| Suite | Skills | Likely Disposition |
|-------|--------|-------------------|
| `morning-briefing` | 6 (briefing + 5 dept standups) | Publish (broadly applicable pattern) |
| `agent-builder` | 1 | Publish (ships with CoS as seed-bundled too) |
| `project-tools` | 3 (quality-gate, create-tests, dev-servers) | Publish (dev workflow pattern) |
| `inbound-triage` | 1 | Rewrite or drop (sales-specific) |
| `jasper-reports` | 2 (blocker-alert, deploy-report) | Rewrite or drop (agent-specific naming) |

Target: ≥2 skills in the registry at `skills-v1.0` tag. Content triage is manual Keepur-side work.

#### 4.2.3 Smoke Test

End-to-end verification against the real repo:

1. `hive skill add morning-briefing` → shallow clones `github.com/keepur/hive-skills`, extracts skill, writes to `<hiveHome>/skills/<workflow>/skills/morning-briefing/SKILL.md` with `origin.type: registry` metadata, commits to `state` branch.
2. Skill loader hot-reloads and indexes the new skill.
3. `hive skill list` shows the installed skill with registry origin.
4. `hive skill remove morning-briefing` cleans up.

Fix any bugs discovered during smoke testing.

### 4.3 Track 8 — Migrate Agent-Authored Skills to Customer Space

#### 4.3.1 Principle

**Agent-created skills are always customer-space.** The write-guard (`src/skills/write-guard.ts`) already enforces this for new writes — agent skill writes must target `<hiveHome>/skills/`, and the guard injects `origin.type: agent-authored` metadata. This principle is not new; it is already implemented. What is new is applying it retroactively to the 5 suites that PR #154 placed in the wrong location.

**Plugin-bundled skills are rare.** A plugin should only bundle a skill when the skill's content is genuinely coupled to the plugin's MCP server — for example, a skill that encodes the specific quirks of a particular API's tooling. If an agent should be able to evolve the skill's content independently of plugin upgrades, it does not belong in the plugin tree.

#### 4.3.2 Migration Steps (dodi-hive)

This is a one-time operation on the dodi-hive deployment, not a generalizable migration tool. It is a direct file operation (copy + metadata injection + git commit), **not** routed through the SDK write-guard. The write-guard (`src/skills/write-guard.ts`) enforces metadata injection for agent writes during live sessions; this migration runs outside any agent session and injects its own metadata.

1. **Copy each suite** from `plugins/dodi/skills/<suite>/` to `<hiveHome>/skills/<suite>/` on the dodi-hive instance. Preserve the existing two-level layout (`<suite>/skills/<skill>/SKILL.md`) that the skill loader expects.

2. **Inject metadata** on each copied `SKILL.md`:
   ```yaml
   origin:
     type: agent-authored
   author:
     agent-id: migrated-from-plugin
     authored-at: <original authoring timestamp if recoverable, else migration timestamp>
     reason: "Migrated from plugins/dodi/skills/ — agent-authored content restored to customer space"
   ```
   The `agent-id: migrated-from-plugin` value is a synthetic marker for migration provenance. It does not correspond to a real agent session — this is intentional and consistent with the frontmatter schema (`author.agent-id` is a free string, not validated against the agent registry).

3. **Commit to state branch** on dodi-hive: `migrate: restore agent-authored skills from plugins/dodi/skills/ to customer space`.

4. **Verify** the skill loader picks up the customer-space copies (they should shadow the plugin-bundled versions due to customer > plugin precedence in `loadSkillIndex`).

#### 4.3.3 Remove Skills from Plugin

After migration is verified on dodi-hive:

1. Delete `plugins/dodi/skills/` directory from the hive repo.
2. Remove the `skills` field from `plugins/dodi/plugin.yaml` (or set to empty array).
3. Commit to the hive repo.

The dodi plugin retains its MCP servers and agent seeds — only the bundled skills are removed. This is consistent with the plugin architecture spec §5.4: plugins should not contain content that agents need to evolve.

#### 4.3.4 Other Deployments

Mike's mac-mini deployment: audit whether `plugins/dodi/skills/` was synced there. If yes, same migration. If his skills are already agent-authored in customer space (per the `ai-analyst` skill noted in KPR-30), those are unaffected.

Future customers: not affected. They install hive fresh with no `plugins/dodi/skills/`. Skills come from the registry (`hive skill add`) or are agent-authored at runtime — both land in customer space by default.

## 5. What Changes

| File | Change |
|------|--------|
| `src/plugins/plugin-loader.ts` | Dual path resolution: `node_modules/<name>/` then `<name>/` (new work — not done in #148) |
| `src/agents/agent-runner.ts` | Same dual-lookup for MCP server spawn paths |
| `src/cli/plugin.ts` | Post-install validation (plugin.yaml + hiveApi), `hive.yaml` update, LaunchAgent restart |
| `package.json` | Add `hiveApi: "1.0.0"` informational field |
| `plugins/dodi/skills/` | Deleted (after migration verified) |
| `plugins/dodi/plugin.yaml` | Remove or empty the `skills` field |
| `github.com/keepur/hive-skills` (new repo) | Flat `skills/<name>/` layout with ≥2 seed skills |

## 6. What Does Not Change

- `src/skills/write-guard.ts` — already enforces agent-authored → customer space.
- `src/agents/skill-loader.ts` — already scans seeds → plugins → customer-space with correct precedence (`loadSkillIndex` takes `customerSkillsDir` as its first arg, scans seed dirs, then plugin skill dirs, then customer-space, with customer winning collisions). This was implemented as part of #148.
- `src/skills/install.ts`, `upgrade.ts`, `remove.ts` — registry install/upgrade/remove flows are complete from #148.
- `src/cli/skill.ts`, `src/cli/registry.ts` — CLI wiring is complete.
- `src/skills/instance-git.ts` — state-branch persistence is wired.
- `src/index.ts:254` — `fs.watch(skillsDir)` hot-reload already active.
- `src/plugins/api-version.ts` — `HIVE_PLUGIN_API_VERSION` stays `"1.0.0"`.

## 7. Deferred (Explicit)

| Item | Reason | When |
|------|--------|------|
| Plugin JSON registry + `--dev-mode` gate | npm scoped packages serve as the registry for now | When third-party plugin publishers emerge |
| `hive_composition` DB writes on install | Filesystem + `hive.yaml` is the source of truth | When multi-instance composition management is needed |
| `hive plugin upgrade` | `remove` + `add` is sufficient | Low priority |
| Install-time `hiveApi` check before npm download | Load-time check already skips incompatible plugins | Nice-to-have polish |
| Full 13-skill triage | Publish what passes review, defer the rest | Ongoing content work |
| In-tree plugin fallback removal | `plugins/dodi/` still uses in-tree layout | When dodi plugin extracts to its own npm package |

## 8. Acceptance Criteria

1. `hive plugin add @scope/hive-plugin-foo` installs, validates `plugin.yaml` + `hiveApi` compat, updates `hive.yaml`, auto-restarts LaunchAgent. Plugin's MCP servers spawn in agent sessions.
2. `hive plugin remove @scope/hive-plugin-foo` uninstalls, updates `hive.yaml`, restarts.
3. `hive plugin list` shows installed plugins with version and hiveApi info, warns on config/disk drift.
4. Post-install validation rollback: if installed package has no `plugin.yaml` or fails `hiveApi` check, `npm uninstall` runs automatically and `hive.yaml` is untouched.
5. `github.com/keepur/hive-skills` exists with ≥2 seed skills at `skills-v1.0` tag.
6. `hive skill add <seed-skill>` works end-to-end against the real registry — installs to customer space with registry metadata, committed to state branch, hot-reloaded by skill loader.
7. `plugins/dodi/skills/` is deleted from the hive repo.
8. On dodi-hive, the 5 skill suites live in customer space (`<hiveHome>/skills/`) with `origin.type: agent-authored`, committed to state branch.
9. Agent-authored skill writes continue to land in customer space (no regression in write-guard behavior).
