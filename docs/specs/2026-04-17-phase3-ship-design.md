---
issue: hive#158
status: draft
date: 2026-04-17
---

# Phase 3 — Ship: Customer Docs + npm Publish

The final gate before onboarding real CEOs. Phase 1 (#159) shipped plugin architecture + skills registry; Phase 2 (#160 + Track 8 work) shipped `hive doctor` and seeded `keepur/hive-plugins` with google/linear/github at 0.1.0. The product is feature-complete. This phase produces the customer-facing surface (docs + onboarding email) and the publish pipeline that puts `@keepur/hive@0.1.0` on the public registry.

## Context

- `package.json` is already publish-shaped: `name: "@keepur/hive"`, `version: "0.1.0"`, `hiveApi: "1.0.0"`, `bin`, `files` whitelist (`pkg/`, `seeds/`, `templates/`, `scripts/honeypot`), `engines: node >=22`.
- All three default plugins are published on npm (`@keepur/hive-plugin-google`, `-linear`, `-github` at 0.1.0). `hive plugin add` works end-to-end.
- `hive doctor` covers prereqs / config / agents / services with `--verbose` remedy hints. Fresh-install runbook exists at `docs/runbooks/fresh-install-doctor-smoke.md`.
- No customer-facing docs exist today. `docs/` contains internal specs and runbooks only.
- No `npm publish` workflow exists. No bootstrap install script exists.

## Audience

Technical CEOs / independent business managers, ~5-10 trust-gate cohort. First impressions are permanent. They have great connections; word travels fast. They are not testers.

## Scope

### Track 16 — Customer-facing docs (in-repo markdown)

Four docs + one email template. Lives in the hive repo, renders on github.com/keepur/hive. When a docs site is justified later, the same files become the source.

1. **`README.md`** (rewrite) — Replaces the current internal-facing README.
   - One-paragraph pitch (what hive is, who it's for)
   - Two install commands prominent at top:
     - Bootstrap (fresh Mac): `curl -fsSL https://raw.githubusercontent.com/keepur/hive/main/install/bootstrap.sh | bash`
     - npm (have Node 22): `npm i -g @keepur/hive && hive init`
   - Links to the three other docs
   - Quick-reference section at the bottom: one-liners for `hive init`, `hive doctor`, `hive plugin add/list/remove`, `hive skill add/list/remove`, `hive update`, `hive start --daemon`

2. **`docs/getting-started.md`** — End-to-end first-run path.
   - Prereqs (the installer handles them; this section names what gets installed and why, so the user isn't surprised when Homebrew prompts for sudo)
   - Both install paths walked through with expected output
   - `hive init` walkthrough: Anthropic key prompt → Slack manifest URL → token prompt → instance config → seed CoS → start service
   - First Slack message: where CoS appears, what it says first
   - Google OAuth walkthrough: `hive plugin add @keepur/hive-plugin-google` → `gog auth login` → CoS confirms in Slack
   - Expected total time: under 20 minutes

3. **`docs/managing-your-hive.md`** — Day-two operations.
   - `hive plugin add/remove/list` with the three published plugins as examples
   - `hive skill add/remove/list` against `keepur/hive-skills` (4 seed skills)
   - `hive doctor` and how to read its output (cross-link troubleshooting.md)
   - `hive update` — how upgrades work, when to run it
   - `hive.yaml` reference: only the fields a customer ever touches (`instance.id`, `agents.default`, `plugins`, `skills.registries`). Internal fields not documented here.
   - `.env` reference: only the keys a customer sets (Anthropic, Slack tokens, optional plugin credentials)

4. **`docs/troubleshooting.md`** — Failure-mode index.
   - "Run `hive doctor --verbose` first" framing
   - Top 5-7 failure modes with diagnosis and fix:
     - MongoDB not running
     - Slack token rejected (`auth.test` fails)
     - ANTHROPIC_API_KEY missing or invalid
     - LaunchAgent not loaded
     - Port conflict on init
     - Plugin install fails `hiveApi` compat check
     - `gog` CLI not on PATH after Google plugin install
   - "Where to get help" — May's contact path for the trust-gate cohort

5. **`docs/onboarding-email.md`** — Plain-text template, ~150 words.
   - 2-line pitch
   - Both install commands
   - Link to `getting-started.md` on github.com
   - "Text me when you're stuck" with May's cell
   - Personalization markers (`{{firstName}}`) so May can copy-paste-edit per recipient. Not a templating engine — just visible placeholders.

**Doc style:** terse, code-first, no marketing prose. Every paragraph either tells the user what to type or what to expect. No screenshots in this phase (they rot fast and the cohort is small enough to walk through Slack app creation by phone if needed) — defer to Phase 4 if onboarding load justifies it.

### Track 17 — npm publish pipeline

1. **`install/bootstrap.sh`** — Bare-metal Mac install script. ~40-60 lines bash.
   - Detects existing Homebrew → installs if missing
   - Detects existing Node ≥22 → installs via `brew install node@22` if missing or older
   - Runs `npm i -g @keepur/hive`
   - Runs `hive init` (interactive — script ends here, user takes over the wizard)
   - Idempotent: safe to re-run if it bails partway
   - Set `set -euo pipefail` at top; explicit failure messages

2. **`.github/workflows/publish.yml`** — Tag-driven publish on self-hosted ARM64 runner.
   - Trigger: `push` event with tag matching `v*`
   - Steps: checkout → `npm ci` → `npm run check` → `npm run build` → `npm pack --dry-run` (logged for audit) → `npm publish --access public`
   - Auth: `NPM_TOKEN` repo secret (added to `keepur/hive` GitHub repo settings as part of this phase)
   - On failure: workflow exits non-zero, no publish happens. Tag stays in git.
   - No GitHub Release creation in this phase (manual via `gh release create` if/when wanted)

3. **`docs/runbooks/fresh-install-publish-smoke.md`** — Pre-tag manual verification.
   - Same pattern as `fresh-install-doctor-smoke.md`
   - Procedure: on a fresh macOS user account (or sandbox), run the curl bootstrap → complete `hive init` → confirm CoS responds in Slack → run `hive plugin add @keepur/hive-plugin-google` and confirm it activates
   - Operator records date + their name in the runbook log section before the maintainer pushes the version tag
   - Done before every minor and major version bump. Patch releases (bug fixes) may skip if the change is mechanically obvious and `npm run check` covers it.

4. **Versioning rules** — Documented in the publish runbook.
   - Strict semver on `version`: patch for fixes, minor for features, major when stable
   - `hiveApi` moves only on breaking changes to the plugin contract: `plugin.yaml` schema, MCP server env passthrough, skill loader API. Stays at `1.0.0` otherwise.
   - Plugins declare `hiveApi: "^1.0.0"`; the loader's `isHiveApiCompatible()` check rejects mismatches.

5. **`README.md` + `docs/getting-started.md` reference the published artifact** — install commands use `@keepur/hive` (no version pin); the npm dist-tag `latest` is what tag-pushes update.

## What changes

| File | Change |
|------|--------|
| `README.md` | Rewrite for customer audience (current README is internal) |
| `docs/getting-started.md` | New — end-to-end first-run path |
| `docs/managing-your-hive.md` | New — day-two operations |
| `docs/troubleshooting.md` | New — failure-mode index |
| `docs/onboarding-email.md` | New — ~150-word email template |
| `install/bootstrap.sh` | New — bare-metal Mac install script |
| `.github/workflows/publish.yml` | New — tag-driven npm publish workflow |
| `docs/runbooks/fresh-install-publish-smoke.md` | New — pre-tag manual verification |

## What does not change

- `package.json` — already publish-shaped from #136 / #151. No changes expected; if the smoke runbook surfaces a `files` whitelist gap, fix it as a sub-task.
- `src/cli.ts`, `src/cli/doctor.ts`, `src/cli/plugin.ts`, `src/cli/skill.ts` — feature complete from prior phases.
- The seeded `keepur/hive-plugins` and `keepur/hive-skills` registries — content is sufficient for 0.1.0; further seeding is post-MVP.
- Honeypot keychain integration — still 3+ months out per #139. Phase 3 documents only the `.env` path that exists today.

## Out of scope (deferred)

| Item | Reason | When |
|------|--------|------|
| Docs site (Docusaurus / GitHub Pages) | In-repo markdown is sufficient for the trust-gate cohort | When public launch or SEO matters |
| Automated Resend onboarding emails | Copy-paste works for ~5-10 customers | When manual cadence becomes a bottleneck |
| `keepur.com/install` short-URL redirect for bootstrap | Direct GitHub raw URL is stable enough | When marketing URL polish matters |
| Screenshots in docs | High maintenance cost, low value at this scale | If onboarding support load justifies |
| GitHub Release notes automation | `gh release create` manually if wanted | Low priority |
| `hive doctor --fix` auto-remediation | Phase 2 deferred; no new pressure to land it | Future |
| Non-Mac platform support | macOS-only is the explicit target | Future |
| Public license file | Closed-source by epic decision (resolved in MVP epic §Open Decisions) — no LICENSE file in tarball | Future business decision |

## Acceptance criteria

1. `README.md` is rewritten for the customer audience with two install commands and a quick-reference section.
2. `docs/getting-started.md`, `docs/managing-your-hive.md`, `docs/troubleshooting.md` exist with the content described above.
3. `docs/onboarding-email.md` exists with a ~150-word template May can personalize.
4. `install/bootstrap.sh` exists, is executable, and runs end-to-end on a fresh macOS user account: installs Homebrew + Node, runs `npm i -g @keepur/hive`, hands off to `hive init`.
5. `.github/workflows/publish.yml` exists. Pushing a `v*` tag on a clean main triggers the workflow on the self-hosted runner; the workflow runs `npm run check`, builds, audits the pack, and publishes to npm with the `NPM_TOKEN` secret.
6. `docs/runbooks/fresh-install-publish-smoke.md` exists with the procedure documented above.
7. The fresh-install publish smoke runbook has been executed once (operator + date recorded) before tagging `v0.1.0`.
8. `@keepur/hive@0.1.0` is published on npm and `npm i -g @keepur/hive` from a fresh machine succeeds.
9. End-to-end DoD: a maintainer (May or another tester) follows the email + `getting-started.md` on a fresh macOS user account and is talking to CoS in Slack within 20 minutes, with no source-tree access and no out-of-band help.

## Risks & open questions

- **`@keepur` npm org membership.** This phase assumes May (or a Keepur npm account) has publish rights to `@keepur/hive`. If org admin work is needed (invite, 2FA enforcement), it must happen before the workflow can publish. Verified out-of-band that the three plugin packages are already published under `@keepur`, so the org exists — confirm `@keepur/hive` package name is reserved and writable before tagging.
- **Self-hosted runner trust for `NPM_TOKEN`.** The runner already runs `npm run check` on every PR. Publishing extends its blast radius to npm. Acceptable given the runner is on Keepur-controlled hardware (Mac Mini), but worth flagging that a leaked `NPM_TOKEN` could publish malicious 0.1.x patches. Mitigation: use a granular npm token scoped to `@keepur/hive` only, not org-wide.
- **Bootstrap script supply-chain posture.** `curl ... | bash` is industry-standard (Homebrew, rustup, nvm) but is the highest-value injection target in this phase. Mitigations: script is in the public hive repo (auditable before running), served from `raw.githubusercontent.com/keepur/hive/main/install/bootstrap.sh` (GitHub-hosted, not a third-party CDN), `set -euo pipefail`, no `eval`, no piped sub-fetches inside the script.
- **First-cohort discovery of doc gaps.** The "expand to full doc set on demand" plan from brainstorm means we expect gaps to surface during onboarding. Risk: a CEO hits a gap, gets frustrated, walks away. Mitigation: May's cell number in the email is the safety net. The trust-gate cohort is small enough that this works.
