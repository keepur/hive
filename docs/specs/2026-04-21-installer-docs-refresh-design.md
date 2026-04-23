# Installer / Updater / Docs Refresh — Design Spec

**Date**: 2026-04-21
**Ticket**: [KPR-54](https://linear.app/keepur/issue/KPR-54) (Phase 4 of [KPR-50](https://linear.app/keepur/issue/KPR-50) — Instance dir restructure, v0.2.0)
**Depends on**: [KPR-52](https://linear.app/keepur/issue/KPR-52), [KPR-53](https://linear.app/keepur/issue/KPR-53)
**Status**: Draft

## Problem

The beta-launch surface area (v0.1.x) was designed around a layout where `<instance>/` *is* the git clone of the deploy branch or the npm-global install root. After Phase 2 (engine moves into `.hive/`) and Phase 3 (deploy stops git-pulling the instance dir), that surface area is no longer correct. If a new customer runs `bootstrap.sh` post-restructure today, they install v0.1.x or they install v0.2.0 against docs that still describe v0.1.x paths.

Concretely out of date:

- `hive init` (the post-npm-install wizard) creates an instance skeleton at `~/services/hive/<id>/` but doesn't populate `.hive/` — it assumes the CLI being run from the global install *is* the engine the instance will use. After Phase 2, the engine must live inside the instance's `.hive/`.
- Public docs reference `~/.hive/logs/`, `~/.hive/.env`, treating `~/.hive/` as the single HIVE_HOME. Actual default since multi-instance work is `~/services/hive/<id>/`. This mismatch predates Phase 2 but gets compounded by the `.hive/` repurpose: telling a user to `cat ~/.hive/logs/hive.log` now reads as "cat the engine dir's logs," which is nonsense.
- `CLAUDE.md`'s "Dev vs Deploy" section describes the old git-clone-as-deploy-dir model explicitly.
- `docs/architecture.md` has a "directory layout" description that still reflects pre-Phase-2.
- `docs/onboarding-email.md` is fine today (just two shell commands) and needs only a version bump / spot-check for broken paths.
- `publish-docs.sh` mirrors three markdown files plus `bootstrap.sh` into the public `keepur/hive-docs` repo. Those three files (`getting-started.md`, `managing-your-hive.md`, `troubleshooting.md`) all need updates.

## Goal

A fresh beta customer who runs the post-restructure `bootstrap.sh` on a clean Mac ends up with a working 0.2.0 hive instance in the new layout. Every public doc describes that layout consistently. The upgrade path (`hive update` / `hive rollback` from Phase 3) is documented, tested, and one-command.

Non-goals:
- Changing the npm package name or license.
- Actually publishing the 0.2.0 release — that happens in the Phase 3 deploy dry run and the Phase 5 coordinated cutover.
- Automating the 0.1.x → 0.2.0 migration for existing customers — that's Phase 5.

## Design

The work is an audit + update across six surfaces. Each surface has an explicit action list.

### 1. `hive init` wizard — populate `.hive/` from the running CLI

**Today**: `runSetupWizard` in `src/setup/init.ts` creates `<instance>/hive.yaml` at `~/services/hive/<instance-id>/` by default, then delegates to `runWizard` in `src/setup/wizard.ts`. The wizard sets `HIVE_HOME=<instance>` and starts the engine, relying on the globally-installed `@keepur/hive` CLI to *be* the engine. After Phase 2, the instance's `.hive/` is the engine — the global install is only the CLI shim.

**After Phase 4**: the wizard adds one new step:

> **Populate engine** — copy the currently-running CLI's package contents into `<instance>/.hive/`.

**Placement.** The wizard in `src/setup/wizard.ts` has numbered steps. `isBundled` is resolved at line 169 (`existsSync(resolve(pkgRoot, "pkg", "server.min.js"))`). Steps 8 (Build, starting line 438) and 9 (Deploy, starting line 455) are wrapped in `if (!isBundled)` blocks — in the bundled path they don't execute at all (there's no `if (isBundled)` counterpart; these steps simply don't exist in the bundled flow). Step 10 is the Service/LaunchAgent section (`section("Service")` at line 482).

`populateEngine` must run:
- **Only when `isBundled === true`.** Non-bundled dev installs run the engine in-place from `~/github/hive/` and have no `.hive/` layer; calling `populateEngine` there is wrong.
- **After step 7 (memory/MongoDB, `doMemory()` at line 435), before step 10 (`section("Service")` at line 482)**. There is no existing `if (isBundled)` guard to land inside — the implementer must create one. Concretely, insert a new block immediately after the closing brace of the `if (!isBundled)` deploy section (line 479, roughly) and before the `section("Service")` call:

```ts
// right after the existing `if (!isBundled) { section("Deploy"); ... }` block closes
if (isBundled) {
  section("Engine");
  populateEngine(pkgRoot, hiveHome);
}

section("Service");
```

Do not nest `populateEngine` inside the `!isBundled` branch — that path doesn't need it and doesn't produce the source files it would copy from.

Implementation:

```ts
// src/setup/populate-engine.ts (new)
import { existsSync, mkdirSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";

// Entries mirror package.json `files` plus package.json itself (which npm
// always includes in a pack tarball but isn't listed in `files`). One path
// per line. `scripts/honeypot` is a single binary (not the whole scripts/
// dir), so the rsync must operate on that exact path.
//
// Why package.json is here: `populateEngine` copies from a local pkgRoot
// (the running CLI's package root), not from a `npm pack` tarball. At that
// source, package.json is a discrete file that needs explicit copy; in a
// tarball it arrives automatically. Including it here keeps the populate
// path symmetric with what Phase 3's fetch_engine produces.
const PACKAGE_ENTRIES = ["pkg", "seeds", "templates", "scripts/honeypot", "package.json"];

export function populateEngine(pkgRoot: string, instanceDir: string): void {
  const engineDir = resolve(instanceDir, ".hive");
  if (existsSync(engineDir)) {
    // Resume path: the wizard may be re-entered after a crash that left
    // .hive/ partially populated. existingInstall() upstream only checks for
    // hive.yaml; it doesn't verify .hive/ completeness. We can't reliably
    // tell a valid .hive/ from a half-written one without a full integrity
    // check, so the safe move is to tear down and repopulate. This is
    // idempotent from the user's point of view: fresh init, clean engine.
    //
    // Guardrail: refuse to wipe if the caller didn't pass through the
    // wizard's re-entry confirmation — pass `force: true` only from the
    // wizard, never from standalone CLI invocations.
    throw new Error(
      `Engine already populated at ${engineDir}. If this is a resume after an ` +
      `interrupted init, rm -rf ${engineDir} and re-run 'hive init'. ` +
      `populateEngine does not silently overwrite.`,
    );
  }
  mkdirSync(engineDir, { recursive: true });

  for (const entry of PACKAGE_ENTRIES) {
    const src = resolve(pkgRoot, entry);
    if (!existsSync(src)) continue;
    const dst = resolve(engineDir, entry);
    mkdirSync(dirname(dst), { recursive: true }); // honeypot needs .hive/scripts/

    // For directories: trailing slash on src tells rsync to copy CONTENTS
    // into dst (not nest the dir inside dst). For files: no trailing slash,
    // rsync copies src to dst as a file.
    const isDir = statSync(src).isDirectory();
    const srcArg = isDir ? `${src}/` : src;
    const dstArg = isDir ? `${dst}/` : dst;
    if (isDir) mkdirSync(dst, { recursive: true });
    execFileSync("rsync", ["-a", srcArg, dstArg]);
  }
}
```

Four correctness notes:

1. **`scripts/honeypot` not `scripts/`.** `package.json` `files` ships the single honeypot binary, not the whole scripts/ dir. Iterating with `"scripts"` in the loop would `existsSync` fail (there's no `scripts/` in a published package) and the honeypot would never land in `.hive/`. The explicit path `"scripts/honeypot"` avoids that.

2. **Parent dir creation.** Since entries can be nested (`scripts/honeypot`), `mkdirSync(dirname(dst))` runs before each rsync so the parent directory exists. The outer `mkdirSync(engineDir)` alone isn't sufficient.

3. **rsync trailing-slash semantics.** `rsync -a /a/pkg /b/pkg` copies `pkg` *into* `/b/pkg`, producing `/b/pkg/pkg/`. Adding trailing slashes — `rsync -a /a/pkg/ /b/pkg/` — copies the *contents* of `/a/pkg/` into `/b/pkg/`, which is what we want. Trailing slashes only apply to directory entries; file entries (`package.json`, `scripts/honeypot`) use plain paths so rsync copies them file-to-file. The `isDir` branch handles both cases.

4. **rsync availability.** macOS ships `/usr/bin/rsync` (Monterey+, ~100% of beta-targeted machines). No special handling.

This keeps `hive init` self-contained (doesn't require network to complete). It also guarantees the installed engine matches the CLI's version, avoiding "CLI is 0.2.0 but `npm pack` fetched 0.2.1" surprise.

Alternative considered: call `deploy.sh --tag=<current-version>` the same way Phase 3 does for upgrades. Rejected because `hive init` runs before the instance has a functional service; invoking the deploy script requires all the deploy prereqs (SLACK_BOT_TOKEN, DEVOPS_CHANNEL_ID) which the fresh install doesn't yet have. Separating fresh-install engine population from deploy-script engine replacement keeps both code paths simpler.

### 2. `bootstrap.sh` (in `install/bootstrap.sh`, mirrored to `hive-docs/install/`)

**Today** (lines reproduced in spec round 1 context): installs Homebrew, Node 22, `npm i -g @keepur/hive`, then execs `hive init`.

**After Phase 4**: mostly unchanged. One addition — pin the version:

```bash
# Before
npm i -g @keepur/hive

# After
npm i -g "@keepur/hive@${HIVE_VERSION:-latest}"
```

This lets us point beta customers at a specific version during the 0.2.0 rollout window. Default behavior (no env var) is unchanged — they get `latest`.

The bootstrap script does *not* need to know about `.hive/` at all; `hive init` does the engine population transparently.

### 3. `src/cli/update.ts` and `src/cli/rollback.ts` — user-facing upgrade

Phase 3 already wires `hive update` (shell out to `deploy.sh --tag=...`) and `hive rollback`. Phase 4 validates the CLI UX:

- `hive update` with no args: upgrade to `latest` published tag.
- `hive update --tag=0.2.1`: upgrade to specific version.
- `hive rollback`: swap `.hive ↔ .hive.prev`, restart.
- `hive rollback --to=0.2.0`: explicit target (error if `.hive.prev/package.json` version doesn't match).

All three commands write a one-line summary to stdout and let `deploy.sh` handle the actual Slack notification. No new code in Phase 4 unless the Phase 3 implementation misses one of the flags above — then Phase 4 catches it.

### 4. npm package layout — audit against `files` in `package.json`

Current `files`: `["pkg/", "seeds/", "templates/", "scripts/honeypot"]`.

After Phase 4 audit, target: unchanged. The `npm pack` output is exactly what Phase 3's `fetch_engine` extracts into `<instance>/.hive/`, and exactly what `populateEngine` copies from a global install. No changes to `files` or to the publish workflow.

One additional check during Phase 4: verify the bundled `pkg/server.min.js` and `pkg/cli.min.js` actually resolve paths correctly when they run from `<instance>/.hive/pkg/`. The `bundle.ts` step uses `esbuild` and hardcodes a small number of `import.meta.url` lookups — verify each resolves to the bundle's location, not to a caller-relative path.

Tests live in `scripts/check-bundle-runtime.mjs`. Phase 4 adds a case that runs `pkg/server.min.js` from a `.hive/pkg/` path and asserts it reads `seeds/` from the sibling `.hive/seeds/`.

**CI coverage note**: `check-bundle-runtime.mjs` is invoked by `npm run check:bundle`, which is separate from the default `npm run check` CI gate. Phase 4 adds `check:bundle` to the CI matrix by appending a step to the existing `.github/workflows/ci.yml` job (the repo has two workflows — `ci.yml` for PR/push checks, `publish.yml` for npm release — the check goes in `ci.yml`). Add a step after the existing `npm run check` step:

```yaml
- name: Bundle runtime check
  run: npm run check:bundle
```

Without this wiring, a bundle regression would silently ship.

### 5. Public docs (`docs/getting-started.md`, `managing-your-hive.md`, `troubleshooting.md`)

**`getting-started.md`**

- Replace `~/.hive/logs/hive.log` references with `<instance>/logs/hive.log` or explicitly name the path (`~/services/hive/<your-instance>/logs/hive.log`). Add a "where is my instance?" paragraph up front that explains the default path.
- The "Running `hive init`" section already describes the wizard steps accurately (sections 1-10); audit each step's described behavior against the Phase 2-aware wizard.
- Add a one-sentence mention of the new layout: "Your instance lives at `~/services/hive/<your-id>/`. The engine is in `.hive/` (wipe-and-replace on upgrade); your config, logs, and agent data live at the instance root and survive upgrades."

**`managing-your-hive.md`**

- The "Plugins" and "Skills" sections are layout-agnostic; verify no path references drift.
- `hive plugin` and `hive skill` commands must still work after Phase 2 — they now install into `<instance>/.hive/plugins/` not `<instance>/plugins/`. Audit `src/cli/plugin.ts` and `src/cli/skill.ts` for consistency with Phase 2's `engineDir` switch; fix if missed there.
- `hive doctor` section — confirm the checks reported still match what Phase 2's integrity checks produce.
- `~/.hive/.env` → `<instance>/.env` throughout.

**`troubleshooting.md`**

- Every `~/.hive/.env` reference → `<instance>/.env` or explicit path.
- Every `~/.hive/logs/hive.log` reference → `<instance>/logs/hive.log` or explicit path.
- Section 4 ("LaunchAgent not loaded") describes the plist at `~/Library/LaunchAgents/com.hive.<id>.agent.plist` — confirm this still points into `<instance>/.hive/dist/index.js` after Phase 2 and that the troubleshooting steps match.

### 6. Internal docs (`CLAUDE.md`, `docs/architecture.md`, `docs/onboarding-email.md`)

**`CLAUDE.md` — "Dev vs Deploy" section**

Current text describes the current model accurately (git clone at deploy dir, npm install in place, etc.). Rewrite to match Phase 2/3:

> - **Dev**: `~/github/hive` — edit source, test, commit, push. Repo layout unchanged from 0.1.x.
> - **Deploy**: `~/services/hive/<instance>/` — instance dir. Engine lives in `<instance>/.hive/` (wipe-and-replace on upgrade). Instance config, agent data, logs at instance root (survive upgrades).
> - **Upgrade**: `hive update [--tag=X]` runs `deploy.sh`, which fetches the tarball and does the `.hive/` swap. `hive rollback` restores `.hive.prev/`.
> - **CI runner**: unchanged.

**`docs/architecture.md`**

Update the "Hive — Agent Orchestration" section's sub-paragraph describing where agents live and what shapes a hive instance. Replace any "the hive repo is cloned into `~/services/hive`" phrasing with the Phase 2/3 description.

**`docs/onboarding-email.md`**

Audit only. The email body currently has two install commands and one docs URL:

- `curl -fsSL .../install/bootstrap.sh | bash` — unchanged. Bootstrap still works end-to-end.
- `npm i -g @keepur/hive && hive init` — **deliberate to leave un-pinned**. The bootstrap script adds a `HIVE_VERSION` knob (see section 2) to let us point at a specific version during cutover, but the copy-paste fallback in the email stays on `latest`. Customers following the manual path during the 0.2.0 rollout window get `latest`, same as today. This is a conscious choice: the email is a human-readable artifact that shouldn't churn per-version.
- Docs URL `https://github.com/keepur/hive-docs/blob/main/docs/getting-started.md` — unchanged.

No rewrite expected. Only the audit above.

### 7. `publish-docs.sh`

Unchanged. The script mirrors three doc files plus `bootstrap.sh` plus `LICENSE`. None of these file paths move in Phase 4. After the doc-update PR merges, running `scripts/publish-docs.sh` syncs the updated docs out to `keepur/hive-docs` and customers see the new content on the next `curl | bash` run.

## Files touched

### Code

- `src/setup/populate-engine.ts` (new) — `populateEngine(pkgRoot, instanceDir)` implementation.
- `src/setup/wizard.ts` — call `populateEngine` after config write, before service start.
- `src/cli/plugin.ts`, `src/cli/skill.ts` — audit for `engineDir` consistency (likely no change if Phase 2 was thorough; this is a verification pass).
- `scripts/check-bundle-runtime.mjs` — add test case that runs `pkg/server.min.js` from a `.hive/pkg/` path.

### Docs

- `install/bootstrap.sh` — add `HIVE_VERSION` env var support.
- `docs/getting-started.md`, `docs/managing-your-hive.md`, `docs/troubleshooting.md` — path references.
- `docs/architecture.md` — directory layout section.
- `docs/onboarding-email.md` — audit only.
- `CLAUDE.md` — "Dev vs Deploy" section rewrite.

### Tests

- `src/setup/populate-engine.test.ts` (new) — assert engine files land in `<instance>/.hive/`, error if already populated, honeypot lands at `.hive/scripts/honeypot` (not `.hive/scripts/`), list of copied entries exactly matches `package.json` `files`.
- `scripts/check-bundle-runtime.mjs` — add the CWD-shifted case.
- `.github/workflows/ci.yml` — append a `Bundle runtime check` step that runs `npm run check:bundle`.

### Not touched in Phase 4

- `package.json` `files`, `bin`, or any publish-workflow config.
- `.github/workflows/publish.yml`.
- `src/*` outside `setup/populate-engine.ts` and the plugin/skill CLI verification pass.
- `publish-docs.sh`.
- License text.

## Runtime failure modes

1. **`populateEngine` called with `.hive/` already populated.** Throws — fresh `init` bails out with a clear error. The wizard's "is this a resume" logic in `existingInstall()` already catches the "existing install" case upstream; this is a defense-in-depth check.
2. **Global CLI install is missing `pkg/` (dev user ran `hive init` from a non-bundled dev install).** `populateEngine` skips missing entries; if `pkg/` is absent, it writes only `seeds/` and `templates/`, and subsequent `hive daemon start` fails health check because there's no `server.min.js`. Mitigation: `hive doctor` catches this with a "engine incomplete: missing pkg/server.min.js" error. Bootstrap path always has `pkg/` because npm ships it.
3. **User points `HIVE_HOME` at an existing instance and runs `hive init --force`.** The `--force` flag doesn't exist; the wizard only has "resume vs fresh" based on `hive.yaml` presence. No action in Phase 4 — this is an intentional guardrail.
4. **Docs out of sync with engine.** Docs-update commits land in this repo; the sync to `keepur/hive-docs` is manual via `scripts/publish-docs.sh`. Phase 4 acceptance includes running `publish-docs.sh` so the public docs match. Going forward, post-merge reviewers are on the hook to re-run it; a CI job to enforce this is out of scope.

## Acceptance

- **Fresh install end-to-end**: on a clean Mac, `curl | bash` bootstrap, complete `hive init` wizard, see `"Hive is running"` in logs, DM the Chief of Staff, get a reply within 10s. Final instance dir has `.hive/` populated, no `.git/`, instance config at root, logs at root.
- **`hive update` and `hive rollback` work**: after the fresh install, `hive update --tag=0.2.1-test` (a test-tag published against a staging registry, or a locally-rsynced variant) swaps `.hive/` and restarts; `hive rollback` restores. Both emit the expected Slack notifications.
- **Docs consistency audit**: grep for `~/.hive/` across `docs/getting-started.md`, `docs/managing-your-hive.md`, `docs/troubleshooting.md`. Zero matches (every reference replaced with the correct post-Phase-2 path).
- **Public docs pushed**: `scripts/publish-docs.sh` runs clean; `keepur/hive-docs` on GitHub has the updated content.
- **Bundle runtime test**: `check-bundle-runtime.mjs` exercises `pkg/server.min.js` from a `.hive/pkg/` location and passes.
- **Onboarding email spot-check**: the two install command blocks in `docs/onboarding-email.md` produce a working 0.2.0 install on a clean machine.

## Open questions

None. `hive init` populates `.hive/` from the running CLI's package root (not from npm registry). Docs refresh is comprehensive across the 6 surfaces listed; no file moves between `hive` and `hive-docs` repos. `bootstrap.sh` gains version-pinning support but otherwise unchanged.
