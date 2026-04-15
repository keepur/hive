# Skills Registry — Distribution and Installation

**Status:** Draft — pending review
**Author:** Mokie + Claude (brainstorm session 2026-04-15)
**Related:**
- `2026-04-15-skills-customer-space-design.md` — the ownership model this spec plugs into. Establishes that registry-installed skills are one of three origins, landing in customer space at `<instance-dir>/skills/`, with specific metadata fields and mutation rules. Read first.
- `2026-04-14-skills-system-design.md` — the current skills design, amended by the customer-space spec. This spec turns §7 (CLI Surface) from "reserved, not built" to "specified here."
- `2026-04-14-plugin-architecture-design.md` — the plugin architecture. This spec's trust posture is deliberately simpler than the plugin posture in §7.2; see `skills-customer-space-design.md` §4.4 for the justification.

---

## 1. Problem

The skills customer-space ownership model (`2026-04-15-skills-customer-space-design.md`) established that registry-installed skills are one of three origin categories. It defined *where* they land (`<instance-dir>/skills/`), *what metadata* they carry (`origin.source`, `origin.base-version`, etc.), and *what rules* govern their mutation (editable, upgrade-with-diff, customer-owned). It deliberately deferred *how the registry itself works* to this spec.

This spec answers the mechanical questions: What is a registry? Where does it live? How does `hive skill add` fetch a skill? How does `hive skill upgrade` decide what to do? What does the CLI look like? How do third-party registries work? How are multi-registry collisions resolved?

Every question has a simple answer, because the architecture is simple: **a registry is a git repository.**

## 2. Goals

1. Define the registry as a git repository with a concrete directory layout.
2. Define the default Keepur registry (location, hosting, curation, publication workflow).
3. Define the CLI surface for `hive skill add/list/upgrade/remove` and `hive registry add/list/remove`, precisely enough to be implemented without further design.
4. Define the flat-to-nested projection rule that maps the registry's layout to hive's runtime layout.
5. Define version identification (commit SHA + optional tags) and upgrade semantics (fetch, compare, diff-if-modified, prompt).
6. Enable third-party registries with zero trust-gate machinery.
7. Enable offline and local installs (`file://` URLs, local clones).

## 3. Non-Goals

- **Web-browser discovery UI** beyond the natural GitHub browsing surface of the registry repo itself.
- **Promotion pipeline from customer-space to the default registry.** See skills-customer-space-design §11.1 — for now, promotion is "submit a PR to the registry repo manually." Cross-fleet pattern detection and automated PR generation are future work.
- **Skill marketplaces** with ratings, reviews, popularity rankings, or recommendation engines. The GitHub repo and its star count are the marketplace.
- **Dependency resolution between skills.** Skills are prose. They don't have dependencies in the technical sense. A skill whose prose says "run the `quarterly-review` skill first" is making a prose reference, not declaring a dependency.
- **Semver constraints.** No `^1.2.0` or `>=1.0.0 <2.0.0` version specs. Git SHAs are the authoritative version identifier; tags are optional reference points.
- **Binary or compiled content in registries.** Skills are markdown plus optional text-file sidecars (scripts, reference documents). No binary assets, no images larger than tiny icons, no compiled executables. If a skill needs a compiled binary, it's probably not a skill — it's part of a plugin's MCP server.
- **Registry authentication** for the default Keepur registry. It's a public open-source repo; reading is unauthenticated. Third-party registries can require authentication (private GitHub repos, ssh keys, etc.) — hive uses whatever git is configured to use on the host and passes through credentials transparently; no custom auth layer in hive itself.
- **Changes to the plugin registry posture** defined in `2026-04-14-plugin-architecture-design.md` §7.2. Plugins keep their more elaborate trust-curation model; this spec is for skills only.

## 4. Principle

**A registry is a git repository. Git is the distribution substrate. There is no hosted service, no custom package format, no bespoke API.**

Everything else in this spec follows from this principle. Fetch is `git clone`. Upgrade is `git fetch` plus SHA comparison. Publication is `git push` (or a PR merged into the registry repo). Discovery is browsing the repo on GitHub. Third-party registries are "any git URL." Offline installs are `file://` URLs pointing at a local clone. Nothing is invented beyond what git already provides.

The default registry is an open-source repo at `github.com/keepur/hive-skills`. Keepur maintains it — reviews PRs, merges contributions from the community and from Keepur's own team, cuts reference tags at meaningful points. Customers install from it by default. Anyone can fork it, maintain their own version, and have their hives pull from the fork instead. Anyone can point their hive at an entirely different git URL and install whatever's there. The customer's trust relationship is with whoever maintains whichever git repo they've chosen to install from, full stop.

## 5. Registry Repository Layout

### 5.1 Directory structure

A registry is a git repo with a `skills/` directory at the top level, and each skill is a direct child of `skills/` as its own directory. Flat. No workflow-grouping subdirectories in the repo.

```
<registry-repo>/
├── README.md
├── CONTRIBUTING.md
├── LICENSE
├── spec/
│   └── hive-skill-format.md       # SKILL.md frontmatter contract for contributors
├── template/
│   └── SKILL.md.example            # starter file for new contributors
└── skills/
    ├── morning-briefing/
    │   ├── SKILL.md                # source of truth for the skill
    │   └── README.md               # optional: human-facing description for GitHub browsers
    ├── sales-standup-prep/
    │   └── SKILL.md
    ├── cs-standup-prep/
    │   └── SKILL.md
    ├── inbound-lead-triage/
    │   └── SKILL.md
    ├── quality-gate/
    │   ├── SKILL.md
    │   └── scripts/
    │       └── run-checks.sh       # sidecar: copied alongside SKILL.md at install
    ├── deploy-report/
    │   ├── SKILL.md
    │   └── references/
    │       └── deploy-checklist.md # sidecar: reference document
    └── ...
```

Each immediate subdirectory of `skills/` is one skill. The skill directory contains `SKILL.md` (required) plus any sidecar files (optional) that the skill's prose references — helper scripts, reference documents, data files, templates. All files in the skill directory are copied as a unit at install time.

This layout matches the convention established by `anthropics/skills`, which uses a flat `skills/<skill-name>/` layout and expresses logical grouping (their "plugin bundles") as manifest metadata rather than directory hierarchy. Other comparable repos (`modelcontextprotocol/servers`, `wshobson/commands`) follow the same pattern: flat per-unit, grouping via metadata or at a single shallow level.

### 5.2 SKILL.md frontmatter contract

Skills submitted to a registry must include the standard frontmatter fields from `2026-04-14-skills-system-design.md` §4.2, plus a new `workflow:` field introduced by this spec for the projection rule in §7:

```yaml
---
name: sales-standup-prep
description: Prepare the sales team's daily standup report from CRM activity
agents: [all]                      # registry-published skills default to [all]; customer narrows post-install
workflow: morning-briefing         # required for registry-published skills
---

# Sales Standup Prep

<skill prose>
```

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | yes | Unique skill identifier within its workflow. Must match the registry directory name. |
| `description` | yes | One-line human summary. Used by `hive skill list --available` and surfaced to agents during discovery. |
| `agents` | yes | Agent IDs the skill should be visible to at runtime (or `[all]`). Registry-published skills should default to `[all]` because the registry cannot know which agent IDs exist on hives that install it; the customer narrows visibility post-install by editing the frontmatter (which flips `origin.modified: true`). Unchanged contract from `2026-04-14-skills-system-design.md` §4.2. |
| `workflow` | recommended | Runtime workflow-grouping directory name. Used by the installer's projection rule (§7.2). Registry-published skills should declare it so the runtime layout is explicit rather than fallback-derived, but the installer accepts absent `workflow:` fields from any source and projects them per §7.2. When absent, the skill is its own single-skill workflow (degenerate case, correct but ugly). |

Because registry-published skills default to `agents: [all]`, they are visible to every agent on the installing hive until the customer narrows them. This is consistent with the opt-in model — once a customer has explicitly installed a skill, making it available to all agents is the safe default, and the customer is expected to edit visibility to match their hive's agent roster.

Agent-authored skills that are never published to a registry can omit `workflow:` — the installer has a fallback (§7.2). Registry-published skills should declare it so the installer can project the flat registry layout into the nested runtime layout rather than falling back to the degenerate case.

### 5.3 Sidecar files

Anything in the skill directory alongside `SKILL.md` is a sidecar and is copied as part of the install. Conventional subdirectories (based on the `anthropics/skills` reference implementation):

- `scripts/` — helper scripts the skill's prose tells the agent to execute (`run ./scripts/analyze.py against the latest data`).
- `references/` — reference documents, checklists, prompt templates the skill prose links to.
- `assets/` — small data files, sample inputs, templates.
- `README.md` — optional human-facing description for GitHub browsers, not consumed by the runtime loader.

These are conventions, not enforcement. A registry is free to include any file layout under a skill directory; the installer copies it verbatim. The only hard rule is **no binaries or large assets** — skills are text-centric content, and a registry whose skill directories are hundreds of megabytes is outside the design envelope.

## 6. Default Keepur Registry

### 6.1 Location

The default registry is `github.com/keepur/hive-skills`. Public, open source, free to fork, free to contribute to via PR.

Hive core has this URL baked in as the default registry when no other configuration is present. Customers can override via `hive.yaml` (§10) if they want a different default — for example, a fork they maintain, or a private internal registry.

### 6.2 Curation

Keepur maintainers review PRs submitted to the registry and merge the ones that meet the content bar. The review criteria are prose-and-markdown review, not automated validation — does this skill describe something useful, is the frontmatter valid, does it follow the format conventions, does it avoid being so business-specific it wouldn't help any other hive, is it not a reimplementation of something that already exists in the registry.

The review gate exists to keep the default registry's content quality consistent, not to enforce security (skills don't have a credential-exfiltration path, per `skills-customer-space-design.md` §4.4). Customers who disagree with Keepur's curation bar can maintain their own registry fork or point their hives elsewhere — there's no lock-in.

### 6.3 Publication workflow

Publication is standard GitHub: fork the repo, add a skill, open a PR, wait for review, merge. No separate publication API, no version-bump command, no "publish to npm" step. The moment a PR is merged, the skill is installable by anyone pointing their hive at the default registry.

Contributors can be Keepur employees (for the initial seed content from the hive core repo's current `skills/` tree after the triage in `skills-customer-space-design.md` §10.3) or external community members. The process is identical.

### 6.4 Reference tags

Keepur cuts git tags at meaningful reference points: `skills-v1.0` for the initial seed content, `skills-v1.1` for minor additions, `skills-v2.0` for any breaking change to the SKILL.md format. Tags are informational, not required for installation — customers can install from main HEAD or from any tag. Tags exist so that `base-tag` in the installed skill's metadata can point at a human-meaningful name ("you're running skills-v1.2 of morning-briefing") in addition to the commit SHA.

Tags are not semver-enforced. `skills-v2.0` doesn't have formal breaking-change semantics the way an npm package version bump does. It's a reference point the maintainer cuts when they want a name for "the state of the registry as of this date."

## 7. Fetch and Install

### 7.1 `hive skill add <name>`

The base case: install a skill by name from the customer's default configured registry.

1. Determine the target registry. With no flags, use the first registry configured in `hive.yaml` (the default Keepur registry if none is configured). With `--from <registry-name>`, use the named registry. With `--from <git-url>`, use that URL directly.
2. **Shallow clone** the registry repo to a temp directory (`git clone --depth 1 <url> /tmp/hive-skill-install-<timestamp>/`). Depth-1 keeps the fetch small and fast.
3. **Resolve the skill directory:** look for `skills/<name>/` in the cloned repo. If not found, error out with the available skill names listed.
4. **Read the SKILL.md frontmatter** and extract the `workflow:` field. If the field is absent, fall back to using `<name>` as the workflow name.
   4a. **Validate the `name:` field.** Read the `name:` field from SKILL.md's frontmatter and compare against `<name>` (the directory name passed to `hive skill add`). If they differ, print a warning: `Warning: registry skill directory 'skills/<dir-name>/' declares name '<frontmatter-name>' in its SKILL.md frontmatter. The directory name is authoritative — installing as '<dir-name>'.` Proceed with the directory name as the authoritative identifier. This is a warning, not a hard error, because registry authors occasionally rename directories without updating frontmatter and the install should not fail for a cosmetic inconsistency.
5. **Construct the runtime target path:** `<instance-dir>/skills/<workflow>/skills/<name>/`.
6. **Copy the entire skill directory** from the temp clone to the runtime target path, verbatim. All sidecar files come along.
7. **Record install metadata** in the SKILL.md frontmatter at the runtime target path:
   - `origin.type: registry`
   - `origin.source: <registry-url>`  (the **clone-able canonical form** of the registry URL, always with a scheme — e.g. `https://github.com/keepur/hive-skills`, or `git@github.com:keepur/hive-skills.git`, or `file:///path/to/local/registry`. This is the exact URL hive passed to git clone; subsequent upgrades pass the same URL to git ls-remote and git fetch without further normalization.)
   - `origin.base-version: <sha>`  (commit SHA of the registry HEAD at install time, `git rev-parse HEAD`)
   - `origin.base-tag: <tag>` (if HEAD points at or is behind a named tag, record it)
   - `origin.installed-at: <ISO-8601 timestamp>`
   - `origin.modified: false`
   - `origin.base-content-hash: <sha-256>` (SHA-256 hash of the skill's installable content, computed per §8.3 — covers SKILL.md (with the `origin:` frontmatter block excluded from the hash input) plus all sidecar files in the skill directory, files concatenated in alphabetical path order separated by null bytes. Stored so that modification detection (§8.3) does not require re-fetching the registry.)
8. **Commit to the instance-local `state` git branch** (per `skills-customer-space-design.md` §7.2), with message `install: <workflow>/<name> from <registry-url>@<sha>`.
9. **Delete the temp clone.**
10. **Signal the skill-loader** to reload the index (SIGUSR1 per `2026-04-14-skills-system-design.md` §6.2), or no-op if the hot-reload hook is not configured.

### 7.2 Projection rule (flat → nested)

The registry's flat layout (`<repo>/skills/<name>/`) maps to hive's nested runtime layout (`<instance-dir>/skills/<workflow>/skills/<name>/`) via the `workflow:` frontmatter field:

| Registry path | SKILL.md `workflow:` field | Runtime path |
|---|---|---|
| `skills/sales-standup-prep/SKILL.md` | `workflow: morning-briefing` | `<instance-dir>/skills/morning-briefing/skills/sales-standup-prep/SKILL.md` |
| `skills/morning-briefing/SKILL.md` | `workflow: morning-briefing` | `<instance-dir>/skills/morning-briefing/skills/morning-briefing/SKILL.md` |
| `skills/quality-gate/SKILL.md` | `workflow: project-tools` | `<instance-dir>/skills/project-tools/skills/quality-gate/SKILL.md` |
| `skills/my-custom-skill/SKILL.md` | *(field absent)* | `<instance-dir>/skills/my-custom-skill/skills/my-custom-skill/SKILL.md` (degenerate: skill is its own workflow) |

The projection handles the fact that hive's runtime needs the two-level nesting for the Claude Agent SDK's local-plugin loading (see `2026-04-14-skills-system-design.md` §4.3), while the registry's flat layout matches the industry convention for prose-content repos.

### 7.3 `hive skill add <registry>:<name>` — explicit registry prefix

When multiple registries are configured and the skill name exists in more than one, the customer disambiguates with a `<registry-name>:<skill-name>` prefix:

```
hive skill add community:quality-gate
hive skill add keepur-default:quality-gate
```

The registry name is the one the customer assigned when running `hive registry add` (§10). If the prefix isn't needed (the skill name is unique across configured registries), it can be omitted. If the prefix is ambiguous or missing and the skill name exists in multiple registries, `hive skill add` errors out and lists the conflicting registries.

### 7.4 `hive skill add <git-url>#skills/<name>` — inline URL

The customer can install from a registry that isn't in their config at all by passing the git URL inline:

```
hive skill add https://github.com/someone/their-cool-skills#skills/quality-gate
```

The fragment (`#skills/<name>`) identifies the skill within the registry repo. This is the canonical inline form for third-party installs and is how documentation, README files, and command-line examples should present skill URLs.

As a best-effort convenience, hive also accepts GitHub web URLs of the form `https://github.com/owner/repo/tree/<branch>/skills/<name>` or `https://github.com/owner/repo/blob/<branch>/skills/<name>/SKILL.md`, which are recognized by a GitHub-specific parser and rewritten into the canonical fragment form before fetching. This is a UX convenience for users who paste links from a browser, not a supported URL grammar. Other git hosts (GitLab, Bitbucket, self-hosted) only support the canonical fragment form.

In either form, hive performs the same shallow-clone-and-extract as the base case (§7.1). The installed skill's `origin.source` records the cloneable registry URL (not the fragment), so upgrades fetch from the registry root as expected.

### 7.5 `hive skill add file:///path/to/local/registry` — offline / local installs

For development, offline environments, or on-premise-only deployments, a local clone of a registry can be installed directly:

```
hive skill add file:///Users/me/dev/hive-skills-fork#skills/quality-gate
```

Hive uses `git clone` with a `file://` URL, which git supports natively. Same extraction and install flow as the remote case.

### 7.6 Fetch-layer error handling

Any failure during fetch, clone, or copy is surfaced to the customer verbatim with a `registry fetch failed:` prefix, and **no partial install is committed** to `<instance-dir>/skills/` or to the instance-local `state` git branch. Specifically:

- **Network failure** (DNS resolution, TCP timeout, TLS handshake): git's error message is printed, `hive skill add` exits non-zero, no side effects.
- **Authentication failure** (ssh key rejected, HTTPS credentials required for private repo): git prompts via the standard credential helper if running interactively; in non-interactive contexts, git's auth error is surfaced and the command exits non-zero.
- **Repository not found** (404, typo in URL): git's error is surfaced, command exits non-zero.
- **Skill not found in repository** (URL is valid but the skill name doesn't exist under `skills/`): hive prints a helpful error listing the available skill names from the clone, then cleans up the temp clone and exits non-zero.
- **Large clone** (repo size exceeds a few hundred megabytes): hive does not enforce a size limit. The customer's disk space and patience are the limits. A future version may add a `--max-clone-size` flag if this becomes a practical concern.
- **Rate limiting by the git host** (GitHub abuse rate limits, etc.): the host's error is surfaced verbatim. Retry is manual — hive does not implement automatic backoff.
- **Missing git binary on the host**: hive detects this at startup (not at fetch time) and refuses to run `hive skill *` commands, printing a clear "git is required for skill installation; install git and retry" message.

The temp clone directory (`/tmp/hive-skill-install-<timestamp>/`) is always removed on exit, including when the install fails partway through. Hive uses a `defer`-style cleanup to guarantee this; the cleanup runs even on process termination (SIGINT, SIGTERM).

Successful installs are atomic from the customer's perspective: either the skill appears at the runtime target path with all its metadata and the `state` branch commit, or nothing changes.

## 8. Upgrade Semantics

### 8.1 `hive skill upgrade <name>`

1. **Read the installed skill's metadata** from `<instance-dir>/skills/<workflow>/skills/<name>/SKILL.md` — specifically `origin.source`, `origin.base-version`, and `origin.modified`.
2. **Fetch the current registry HEAD:** `git ls-remote <origin.source>` or a shallow fetch. Get the current commit SHA of the default branch.
3. **Compare SHAs:** if the current HEAD SHA equals `origin.base-version`, there's nothing to upgrade. Print "already up to date" and exit.
4. **Clone the registry** to a temp directory. For upgrades specifically (unlike the install path in §7.1 which uses `--depth 1`), the clone must be able to access both the current HEAD and the stored `origin.base-version` commit. The recommended strategy is `git clone --filter=blob:none --no-checkout <url>` followed by fetching both refs, which keeps the clone small but makes arbitrary SHAs reachable. If the server does not support partial clones, fall back to a full clone (`git clone <url>`). If `origin.base-version` is unreachable from any ref on the remote (for example because the registry has been force-pushed or rebased), the upgrade flow degrades to a **two-way diff** (yours vs. theirs, no base) in step 6, and §8.1 step 8's three-way merge is replaced by a simpler 'keep yours / take theirs' prompt with no automatic merge option.
5. **Resolve the skill directory** in the clone: `skills/<name>/`. If the skill no longer exists in the registry, print a warning ("`<name>` was removed from `<source>` at commit `<sha>` — keeping your installed copy") and leave the installed copy untouched.
6. **Compute the versions** the customer needs to reconcile:
   - **Base:** the content of `skills/<name>/` at `origin.base-version`, fetched from the registry clone by checking out that SHA. **If the base SHA is unreachable** (force-push, rebase, etc.), skip this computation and fall through to the two-way degraded path in step 8.
   - **Theirs (new upstream):** the content of `skills/<name>/` at the current registry HEAD.
   - **Yours (installed):** the content of `<instance-dir>/skills/<workflow>/skills/<name>/` on disk.
7. **If `origin.modified == false`:** apply the upstream version cleanly. Overwrite the installed skill directory with the `theirs` content. Update `origin.base-version` to the new SHA, `origin.base-tag` if relevant, `origin.installed-at` to now. Commit the change to the `state` branch with message `upgrade: <workflow>/<name> <old-sha> → <new-sha>`.
8. **If `origin.modified == true`:** the customer has local edits. The prompt depends on whether a base version is reachable.
   - **If base is reachable (three-way case):** present the three-way diff (base vs. theirs vs. yours) and prompt `[k]eep your version`, `[t]ake the upstream version`, or `[m]erge`. Merge semantics per the original step 8 description. After a successful merge, `origin.modified` flips to `false` if the merge result is byte-identical to `theirs`, and stays `true` otherwise (the customer's content diverges from upstream HEAD).
   - **If base is unreachable (two-way degraded case):** present a two-way diff (yours vs theirs) and prompt `[k]eep your version` or `[t]ake the upstream version`. No automatic merge option. If the customer chooses `[t]ake`, back up `yours` to `<instance-dir>/.hive/skill-backups/<workflow>-<name>-<timestamp>/` and apply `theirs`. If the customer chooses `[k]eep`, do nothing (`origin.base-version` stays at the old SHA).
9. **Signal the loader to reload** after any content change.

### 8.2 `hive skill upgrade --all`

Run §8.1 for every installed registry-sourced skill. Collect the set of skills that either applied cleanly or need customer prompts. Show the prompts one at a time (or batch them via an editor-style review flow — implementation detail). Skills are processed in alphabetical order by `<workflow>/<name>` to make the command output deterministic and the prompt sequence predictable for the customer.

### 8.3 Detecting `modified: true`

The customer can set `origin.modified: true` manually (by editing the SKILL.md frontmatter), but the loader also detects modification automatically. On loader reload, for any skill with `origin.type: registry` and `origin.modified: false`, the loader compares the current content hash of the skill directory against the hash at `origin.base-version` (which can be recomputed from the registry or stored alongside `base-version` as `base-content-hash`). If the hashes differ, flip `origin.modified: true` and record the modification timestamp.

The auto-detection works by storing a `base-content-hash` at install time (recorded in §7.1 step 7) and recomputing it on loader reload. The hash must be stable across repeated installs of the same registry version and must change whenever any customer-visible content changes.

**Hash invariants:**
- The hash input is the skill directory's SKILL.md file (with the `origin:` frontmatter block excluded) concatenated with all sidecar files, in alphabetical path order relative to the skill directory root, with files separated by a single null byte (`\x00`).
- The `origin:` block is excluded because install-time metadata injection would otherwise immediately flip `modified: true` on every fresh install.
- File contents are hashed verbatim — no line-ending normalization, no whitespace trimming — so hand-editing a single character in SKILL.md's prose is detected.
- The hash algorithm is SHA-256. Hex-encoded in the frontmatter as a 64-character string.

**Auto-detection on loader reload:** for any skill with `origin.type: registry` and `origin.modified: false`, the loader recomputes the hash and compares against `origin.base-content-hash`. If they differ, flip `origin.modified: true` and write the current timestamp to the frontmatter.

**Performance:** recomputing the hash on every loader reload is cheap (SHA-256 over a few kilobytes of prose per skill), but the loader may short-circuit by checking the skill directory's `mtime` first and skipping the hash recompute if nothing has changed since the last check. This is an implementation optimization, not a spec requirement.

The `base-content-hash` field is present in `2026-04-15-skills-customer-space-design.md` §6.2's metadata example, matching this spec's §8.3 invariants. This spec is the authoritative definition of the hash computation; the customer-space spec merely carries the field in its frontmatter example for completeness.

## 9. Removal

### 9.1 `hive skill remove <name>`

1. Resolve the installed skill directory at `<instance-dir>/skills/<workflow>/skills/<name>/`.
   1a. **Check for customer modifications.** If the skill's `origin.modified: true`, print a warning: `Warning: <workflow>/<name> has local modifications that will be removed. Your changes are preserved in git history on the 'state' branch; you can recover them later with 'git show state:skills/<workflow>/skills/<name>/'. Proceed? [y/N]` and require an affirmative response unless `--force` is passed. Agent-authored skills (`origin.type: agent-authored`) are treated the same way — any skill in customer space might have edits worth warning about, regardless of origin type.
2. Delete the directory.
3. Commit the removal to the `state` branch with message `remove: <workflow>/<name>`.
4. Signal the loader to reload.

Uninstall is unconditional — there is no "are you sure?" prompt unless the customer passes `--confirm`. The `state` branch preserves the content in history so an accidental removal can be recovered via `git checkout state~1 -- skills/<workflow>/skills/<name>`.

### 9.2 No cascade

Removing a skill does not affect other skills that might reference it in their prose. Skills don't have declared dependencies (per §3), so there's no graph to traverse. If another skill's prose says "after running `sales-standup-prep`, do X" and `sales-standup-prep` has been removed, the referring skill just fails or hallucinates. That's a prose problem, not a dependency problem, and it's the customer's responsibility to keep their installed set coherent.

## 10. Registry Configuration

### 10.1 `hive.yaml` schema extension

Customers configure their registries in `hive.yaml`:

```yaml
# hive.yaml

# ... existing fields ...

skillRegistries:
  - name: keepur-default
    url: https://github.com/keepur/hive-skills
    default: true                    # this is the default for `hive skill add` without --from
  - name: community
    url: https://github.com/hive-community/skills
  - name: acme-internal
    url: git@github.com:acme-corp/hive-skills-internal.git
  - name: local-dev
    url: file:///Users/me/dev/hive-skills-fork
```

Fields:

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | yes | Short identifier used in `--from` flags and `<registry>:<name>` prefixes. Must be unique within the file. |
| `url` | yes | Git URL (https, ssh, or `file://`). |
| `default` | no | If `true`, this registry is used by `hive skill add` without a `--from` flag. Exactly one registry may be marked default. If none is marked, the first in the list is default. |

If more than one registry is marked `default: true` in `hive.yaml` (which can happen if the customer hand-edits the file incorrectly), hive emits a warning at startup naming the conflicting entries and treats the first one in document order as the default. The `hive registry add --default` command writes to `hive.yaml` in a way that preserves uniqueness, so this malformed state only arises from manual edits.

A fresh hive with no `skillRegistries` configured uses a baked-in default of `{name: keepur-default, url: https://github.com/keepur/hive-skills, default: true}`.

### 10.2 `hive registry add` CLI

```
hive registry add <url> [--as <name>] [--default]
```

Adds a registry to the `hive.yaml` configuration. Writes to the `skillRegistries` list. `--as <name>` assigns a short name; if omitted, the name is inferred from the URL (e.g. `github.com/acme/hive-skills` becomes `acme-hive-skills`). `--default` marks this registry as the default and unsets the previous default.

### 10.3 `hive registry list` / `hive registry remove`

```
hive registry list
hive registry remove <name>
```

Straightforward: print the configured registries, or remove one. Removing a registry doesn't uninstall any skills that were previously installed from it — those skills keep their `origin.source` metadata and can still be upgraded (`hive skill upgrade` uses `origin.source` directly, not the named configuration).

### 10.4 Multi-registry resolution

For `hive skill add <name>` with no prefix or `--from` flag, hive resolves the skill name by searching configured registries in order:

1. **Single match:** if only one configured registry has a skill named `<name>`, install from that registry without prompting.
2. **Multiple matches:** error out, print the registries that have a matching skill, and prompt the customer to use a `<registry>:<name>` prefix or a `--from` flag.
3. **No match:** error out, suggest the customer run `hive skill list --available` to see what's installable.

For `hive skill add <registry>:<name>`, resolution is unambiguous — the registry name is explicit, and the install proceeds directly against that registry.

For `hive skill add <git-url>#skills/<name>`, the registry isn't looked up in the configured list at all — the URL is used directly. The installed skill's `origin.source` records the full URL, and subsequent upgrades fetch from the same URL.

## 11. Listing and Discovery

### 11.1 `hive skill list`

Lists skills currently installed in customer space (`<instance-dir>/skills/`). Output columns: `name`, `workflow`, `origin` (one of `registry` or `agent-authored` — plugin-bundled skills are not listed here because they live in plugin trees, not customer space; see `hive plugin list` for plugin-bundled content), `source` (registry URL for registry-sourced, or authoring agent-id for agent-authored), `modified` (yes/no for registry-sourced; always `-` for agent-authored since the concept of unmodified base does not apply).

### 11.2 `hive skill list --available [--from <registry>]`

Lists skills available for installation from a configured registry (or all registries if `--from` is omitted). Implementation: shallow-clone the registry (or use `git archive` to avoid a full clone), enumerate `skills/*/SKILL.md`, read the frontmatter `description` field, print `name | description` pairs.

For a more efficient implementation, registries can publish a top-level `INDEX.md` or `index.json` that enumerates skills with descriptions, avoiding the need to clone the whole repo. This is an optimization, not required — the unoptimized shallow-clone path always works. The default Keepur registry may add an index file at a later date once the skill count grows enough that the unoptimized path is noticeably slow.

### 11.3 `hive skill search <query>`

Grep over the list of available skills (names and descriptions) for a query string. Simple substring match, case-insensitive. Not a full-text search — if the customer wants to search inside skill prose, they browse the registry on GitHub.

### 11.4 Discovery beyond CLI

The GitHub surface of each configured registry is the discovery surface beyond CLI listing. Customers can browse `github.com/keepur/hive-skills` in a web browser, read SKILL.md files rendered as markdown, and decide what to install. No separate hive-hosted discovery UI is in scope for this spec.

## 12. Trust Model

Minimal, per `skills-customer-space-design.md` §4.4.

- No registry curation gate in hive itself. Any git URL works. No `--dev-mode` flag, no security warning, no production-mode disable switch.
- **Customer responsibility:** read what you install. Read the SKILL.md, skim any sidecar scripts, decide if you trust the content. This is the same responsibility any open-source software imposes.
- **Architectural backstop:** skills cannot reach credentials under the Honeypot model. The worst a malicious skill can do is operational harm — wrong emails, wrong CRM updates, budget burn — all of which are recoverable. The backstop makes the minimal trust model safe.
- **No third-party registry hostile-takeover mitigation.** If the maintainer of a third-party registry becomes malicious or their account is compromised, subsequent upgrades could pull in malicious content. This is a supply-chain risk the customer accepts when choosing to configure a non-Keepur registry. The mitigation is the same as for any open-source dependency: the customer reviews updates before accepting them (which the upgrade-with-diff flow in §8 supports).

## 13. Implementation Steps (Outline)

As with `skills-customer-space-design.md`, this is an outline to inform the subsequent implementation plan, not a plan itself.

1. **Git fetch layer** — a small module that shallow-clones a git URL to a temp directory, supports https, ssh, and file:// URLs, cleans up on exit. Wraps `git` CLI rather than reimplementing git over HTTPS. Also supports a partial-clone (`--filter=blob:none --no-checkout`) mode for upgrade fetches that need to access arbitrary historical SHAs beyond current HEAD (per §8.1 step 4).
2. **Registry resolver** — reads `hive.yaml skillRegistries`, handles single-match vs multi-match resolution for `hive skill add <name>`, parses `<registry>:<name>` prefixes and inline git URLs.
3. **Projection rule** — reads `workflow:` frontmatter from a SKILL.md, constructs the runtime target path, handles the fallback case for missing `workflow:`.
4. **Install flow** — wires fetch + resolve + projection + copy + metadata injection + state-branch commit + loader reload into `hive skill add`.
5. **Upgrade flow** — fetch latest, compare SHAs, three-way diff, interactive prompt for modified skills, state-branch commit.
6. **Remove flow** — delete directory, state-branch commit.
7. **List / search** — walk installed skills, walk available skills from registry, frontmatter extraction, substring match.
8. **Registry configuration commands** — `hive.yaml` reader/writer for `skillRegistries`, `hive registry add/list/remove` CLI.
9. **Default registry seed** — set up `github.com/keepur/hive-skills`, publish the skills that survive the triage in `skills-customer-space-design.md` §10.3 as the initial content, cut `skills-v1.0` tag.
10. **CLI wiring** — add `hive skill` and `hive registry` subcommands to the main hive CLI, wired to the flows above.

Steps 1–8 can be implemented in a single PR on the hive-core side. Step 9 is a repo-creation and publication task on the Keepur side, which can happen in parallel. Step 10 is scaffolding that lands with the rest.

## 14. Amendments to Other Specs

### 14.1 `2026-04-14-skills-system-design.md`

- **§7 (CLI Surface):** Move from "Reserved, Not Built" to "Specified in `2026-04-15-skills-registry-design.md`." The commands listed as reserved in §7 fall into two groups: `hive skill add`, `hive skill remove`, `hive skill list`, and `hive skill upgrade` are **specified in this spec** (§7 through §11 above). `hive skill enable --agent` and `hive skill disable --agent` remain **future work** — the convenience equivalent today is editing the `agents:` frontmatter field in the installed SKILL.md directly, which is already documented in `2026-04-14-skills-system-design.md` §7. Add a cross-reference paragraph to skills-system-design §7 pointing at this spec for the implemented commands.
- **§4.2 (SKILL.md frontmatter):** Add the new `workflow:` field to the frontmatter contract. It is required for registry-published skills; optional for agent-authored skills (with the installer fallback per §7.2 of this spec).

### 14.2 `2026-04-15-skills-customer-space-design.md`

- **§6.2 (Metadata on SKILL.md frontmatter):** The `base-content-hash` field is present in the metadata example in the customer-space spec, matching §8.3 of this spec. This spec remains the authoritative definition of the hash computation; the customer-space spec carries the field in its frontmatter example for completeness.
- **§11.1 (Registry interaction details):** Already points at this spec as the companion — no further change needed.

### 14.3 `2026-04-14-plugin-architecture-design.md`

No changes. The plugin registry posture in §7.2 remains as-is. The skills asymmetry is explicitly documented in `skills-customer-space-design.md` §4.4 and the §12.2 amendment note already added by that spec.

## 15. Acceptance Criteria

This spec is done when:

1. A registry is defined concretely as a git repo with a flat `skills/<name>/` layout, matching the industry convention documented in §5.
2. The `workflow:` frontmatter field is specified, and the flat-to-nested projection rule (§7.2) is precise enough to implement without ambiguity.
3. The CLI surface (`hive skill add/list/upgrade/remove`, `hive registry add/list/remove`) is defined precisely enough to be scaffolded, including flag semantics and multi-registry resolution.
4. The upgrade flow (§8) handles the unmodified case (apply cleanly) and the modified case (three-way diff with keep/take/merge prompts) without clobbering customer edits.
5. The default Keepur registry is defined (URL, hosting, curation process, publication workflow) and the initial seed content is sourced from the triage in `skills-customer-space-design.md` §10.3.
6. Third-party registries work without any additional trust machinery — `hive skill add <git-url>` and `hive registry add <url>` are the entire API, no flags or warnings.
7. The spec's §12 trust-model posture is consistent with the `skills-customer-space-design.md` §4.4 asymmetry with plugins — there is no contradiction between the two specs.
