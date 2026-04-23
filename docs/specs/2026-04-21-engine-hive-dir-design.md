# Engine → `.hive/` Relocation — Design Spec

**Date**: 2026-04-21
**Ticket**: [KPR-52](https://linear.app/keepur/issue/KPR-52) (Phase 2 of [KPR-50](https://linear.app/keepur/issue/KPR-50) — Instance dir restructure, v0.2.0)
**Depends on**: [KPR-51](https://linear.app/keepur/issue/KPR-51) (Phase 1)
**Status**: Draft

## Problem

After Phase 1, agent writes no longer pollute `HIVE_HOME`. But the instance root is still a git clone of the engine: `dist/`, `node_modules/`, `src/`, `build/`, `plugins/claude-code/`, plus all the dotfiles and configs that come with the engine repo. An instance dir is indistinguishable from a dev checkout. Upgrades are a `git pull` against a live process.

This makes upgrade semantics muddy:
- What counts as engine content (wipe-and-replace safe) vs. instance state (must survive upgrades)?
- What happens when an upgrade needs to delete a file that used to ship with the engine but doesn't anymore?
- How do two instances on the same machine pin to different versions (dodi on `v0.2.x`, keepur on `v0.1.x`) when they're both git clones pulling the same branch?

## Goal

Move all engine contents into `<instance>/.hive/`. After this ships, the contract is:

> **`.hive/` is an upgrade boundary.** Wipe it, drop in new-version contents, restart. That's the whole deal.

```
rm -rf <instance>/.hive
tar -xzf @keepur-hive-<version>.tgz -C <instance>/.hive
launchctl kickstart -k gui/$(id -u)/com.hive.<instance>.agent
```

...and the instance boots healthy.

This is Phase 2 only. Phase 3 rewrites `deploy.sh` to *use* this contract; Phase 4 refreshes installer/docs; Phase 5 migrates existing 0.1.x instances.

Non-goals: changing the deploy flow (Phase 3), changing how fresh customers install (Phase 4), migrating existing dodi/keepur instances (Phase 5).

## Design

### Target layout

```
<instance>/
  .hive/                        ← ENGINE (wipe-and-replace)
    dist/                       ← compiled JS
    node_modules/               ← prod deps
    src/                        ← source (shipped for debugging only, optional)
    seeds/                      ← agent seed files
    service/                    ← deploy.sh, install.sh, instances.conf, plist templates
    plugins/
      claude-code/              ← Claude Code plugins (engine-side)
      node_modules/             ← npm-installed plugin deps
      <plugin-name>/            ← optional in-tree plugin builds
    package.json
    package-lock.json
  .hive-state/                  ← INSTANCE-LOCAL ENGINE STATE (survives upgrades)
    git/                        ← instance-git working tree
    installed-snapshot.json     ← what the current engine shipped
    previous-snapshot.json      ← snapshot from prior install (for upgrade-notice diff)
    upgrade-notice-emitted      ← one-shot flag
  .hive-generated.json          ← INSTANCE CONFIG CACHE (survives upgrades)
  .env                          ← SECRETS (survives upgrades)
  .env-personal                 ← alt-instance secrets
  hive.yaml                     ← INSTANCE CONFIG (survives upgrades)
  hive-personal.yaml
  beekeeper.yaml
  logs/                         ← OBSERVABILITY (survives upgrades)
  logs-personal/
  logs-beekeeper/
  service/                      ← GENERATED LIVE PLIST (survives upgrades)
    com.hive.<id>.agent.plist   ← referenced by ~/Library/LaunchAgents/ symlink
  agents/                       ← PER-AGENT HOMES (from Phase 1)
  workflow/  data/  skills/  plugins/  ← INSTANCE-AUTHORED (from Phase 1)
```

### What moves vs. what stays

| Today (0.1.x) | After Phase 2 (0.2.0) | Notes |
|---------------|------------------------|-------|
| `<instance>/dist/` | `<instance>/.hive/dist/` | Entry point changes to `.hive/dist/index.js` |
| `<instance>/node_modules/` | `<instance>/.hive/node_modules/` | |
| `<instance>/src/` | `<instance>/.hive/src/` | Optional — dev builds ship it, prod tarballs may omit |
| `<instance>/seeds/` | `<instance>/.hive/seeds/` | Already resolved via `import.meta.dirname` — follows the move automatically |
| `<instance>/package.json` | `<instance>/.hive/package.json` | |
| `<instance>/package-lock.json` | `<instance>/.hive/package-lock.json` | |
| `<instance>/plugins/claude-code/` | `<instance>/.hive/plugins/claude-code/` | Engine-side plugins |
| `<instance>/plugins/node_modules/` | `<instance>/.hive/plugins/node_modules/` | Engine-installed plugin deps |
| `<instance>/service/deploy.sh`, `install.sh`, `instances.conf` | `<instance>/.hive/service/` | Engine-authored scripts |
| `<instance>/service/<label>.plist` | `<instance>/service/<label>.plist` | **Stays at instance root** — generated live plist, must outlive engine wipe |
| `<instance>/.hive/git/` | `<instance>/.hive-state/git/` | Was the "metadata `.hive/`"; renamed to make the upgrade boundary clean |
| `<instance>/.hive/installed-snapshot.json` | `<instance>/.hive-state/installed-snapshot.json` | Same rename |
| `<instance>/.hive/previous-snapshot.json` | `<instance>/.hive-state/previous-snapshot.json` | Same rename |
| `<instance>/.hive/upgrade-notice-emitted` | `<instance>/.hive-state/upgrade-notice-emitted` | Same rename |
| `<instance>/.hive-generated.json` | `<instance>/.hive-generated.json` | Unchanged |
| `<instance>/hive.yaml`, `.env`, `logs/`, `beekeeper.yaml` | unchanged | Instance state |
| `<instance>/agents/`, `workflow/`, `data/`, `skills/`, `plugins/` | unchanged | From Phase 1, instance-authored |

### The `.hive-state/` rename (important)

`.hive/` today is the "metadata dir" — holds the instance's git working tree (`initInstanceGit`), the installed-snapshot, the previous-snapshot, and the upgrade-notice flag. Phase 2 repurposes `.hive/` as the **engine root**, which must be wipe-and-replace safe.

These two semantics collide: if `.hive/` is wiped on upgrade, the snapshots and the instance-git tree go with it. That breaks both the upgrade-notice diff and whatever depends on instance-git history.

Resolution: move the existing `.hive/` metadata contents into a new sibling `<instance>/.hive-state/` dir that's persistent across upgrades. After the move, `.hive/` is pure engine code, `.hive-state/` is pure instance state, and the upgrade boundary is clean.

Naming: `.hive-state/` parallels `.hive-generated.json` in the "dotfile + hive prefix" pattern already at instance root. Alternative considered: keep as `.hive/` and just declare specific sub-paths as survive-the-wipe exceptions — rejected because the contract becomes "wipe `.hive/` except these 4 paths", which is fragile and makes automation error-prone.

### Code changes

**`src/paths.ts`**

```ts
// NEW: the engine root — where dist/, node_modules/, seeds/, service/ live
export const engineDir = resolve(hiveHome, ".hive");

// RENAMED: hiveMetaDir → hiveStateDir, repointed
export const hiveStateDir = resolve(hiveHome, ".hive-state");

// NEW: derived from hiveStateDir — instance-git needs this at multiple call sites inside instance-git.ts
export const instanceGitDir = resolve(hiveStateDir, "git");

// UNCHANGED
export const hiveHome = resolveHiveHome();
export const skillsDir = resolve(hiveHome, "skills");
export const seedsDir = resolve(import.meta.dirname, "..", "seeds"); // still package-relative
```

`seedsDir` remains package-relative (`import.meta.dirname`) and naturally follows the engine into `.hive/`. No callers need to change.

**`resolveHiveHome()` default path change — breaking change tolerable in v0.2.0.** Current (0.1.x) fallback at `paths.ts:17` returns `resolve(home, ".hive")` when neither `HIVE_HOME` env nor a `./hive.yaml` is present. Under the new layout that would make the engine root `~/.hive/.hive/` — functional but absurd-looking, and it traps the operator into a directory name mismatch (their "hive home" is literally named `.hive`). Change the fallback to `resolve(home, "hive")` (no leading dot, instance dir is user-visible). This is a breaking change; mitigation:

- All currently-running 0.1.x instances have `HIVE_HOME` set explicitly via their LaunchAgent plist's `EnvironmentVariables` block — the fallback doesn't fire for them, so the rename doesn't affect live operations.
- Fresh npm installs after 0.2.0 start at `~/hive/` by default.
- Phase 5's migration script is the authoritative path for existing instances — it does not rely on the fallback, so no conflict.
- `bootstrap.sh` and the Phase 4 installer prompts set `HIVE_HOME` explicitly; they never rely on the fallback either.

The fallback matters only for dev-mode-outside-a-repo or manually-run scripts. A single release-notes line ("default `HIVE_HOME` is now `~/hive`, not `~/.hive`") suffices.

**`src/skills/instance-git.ts`**

The file hardcodes `resolve(hiveHome, ".hive", "git")` in six places (`initInstanceGit`, `gitCmd`, `commitToState` — twice — and `commitRemovalToState`). Refactor: stop re-deriving the path per-function; import `instanceGitDir` from `paths.ts` and use it directly. Drop the `hiveHome` arg from internal `gitDir` computation (the functions still take `hiveHome` for `GIT_WORK_TREE` and `cwd`, but not for the `GIT_DIR` location).

Also update `mkdirSync(resolve(hiveHome, ".hive"))` at line 19 to `mkdirSync(hiveStateDir, { recursive: true })` — the parent of `instanceGitDir` is `hiveStateDir`, not the old `.hive/`.

**`src/skills/integrity.ts`**

Two changes, not one:

1. `verifyPackageIntegrity(hiveHome, hiveMetaDir)` — rename the parameter to `hiveStateDir`. No functional change; the function reads `installed-snapshot.json` from whatever path is passed in.

2. `writeSnapshot(packageRoot, declaredFiles)` at line 83 — currently writes to `resolve(packageRoot, ".hive", "installed-snapshot.json")`. Under the new layout `packageRoot` *is* the engine root (`<instance>/.hive/`), so the write lands at `<instance>/.hive/.hive/installed-snapshot.json` — wrong. Change the signature to `writeSnapshot(stateDir, packageRoot, declaredFiles)` — `packageRoot` is still needed to resolve the declared files (they live inside the engine root), but the output snapshot lands under `stateDir`. Pass `hiveStateDir` and `engineDir` at the call site. The snapshot is instance state, not package content — the old signature was conflating two concerns.

   **Note on call site**: `writeSnapshot` has no in-tree callers today (`grep -r writeSnapshot src/` returns only the definition). It's invoked from the install/bootstrap path, which is exactly what Phase 4 (installer docs refresh) builds out. Phase 2's signature change is forward-compatible — Phase 4's installer calls the new signature directly, no compatibility shim needed. In Phase 2, the implementer updates the signature and any unit tests that exercise `writeSnapshot` directly (see Tests section). A first real caller lands in Phase 4.

3. `checkAllowlistDrift` at line 52: the `PACKAGE_PATHS` set (`dist`, `node_modules`, `package.json`, `package-lock.json`, `pkg`, `seeds`, `templates`) is dead weight after Phase 2 — those paths move into `.hive/` and never appear at `hiveHome`. Remove the `PACKAGE_PATHS` set entirely; keep only the `ALLOWLISTED` prefix list.

   Also update the dotfile-skip guard at line 70 (`if (entry.startsWith(".") && entry !== ".hive") continue`). After Phase 2, `.hive-state/` is a new persistent dotfile-dir that should be known to the allowlist, not silently swallowed. Two options, both acceptable:

   - **Option A (minimal)**: extend the guard to `entry !== ".hive" && entry !== ".hive-state"`. Rest of logic unchanged.
   - **Option B (cleaner)**: drop the special-case dotfile exception entirely; add `.hive` and `.hive-state` to `ALLOWLISTED` (they're already checked via `startsWith` prefix match, which matches full names too). Then the one check covers everything.

   Pick Option B — it collapses two filters into one and is easier to reason about. Final `ALLOWLISTED`: `["skills", "plugins", "workflow", "data", "agents", "logs", ".hive", ".hive-state", ".env", "hive.yaml", "hive-", "beekeeper.yaml", ".hive-generated.json"]`. (The Phase 1 sibling dirs — `workflow`, `data`, `agents` — were previously un-allowlisted; fold them in now.)

**`src/skills/upgrade-notice.ts`**

Rename parameter `hiveMetaDir` → `hiveStateDir`. No functional change.

**`src/index.ts`**

```ts
import { skillsDir, hiveHome, hiveStateDir } from "./paths.js";

verifyPackageIntegrity(hiveHome, hiveStateDir);
checkAllowlistDrift(hiveHome);
initInstanceGit(hiveHome);              // initInstanceGit writes under hiveStateDir internally
checkUpgradeNotice(hiveStateDir, skillsDir);
```

**`src/config.ts` — plugin discovery**

Current (line 31): `const parentDir = resolve(hiveHome, "plugins/claude-code");`

New: `const parentDir = resolve(engineDir, "plugins/claude-code");`

Agent-side plugins (instance-authored, Phase 1 sibling dirs) are separate — `<hiveHome>/plugins/` (not `<hiveHome>/plugins/claude-code/`). If and when customer-authored Claude Code plugins are supported, they land in `<hiveHome>/plugins/<name>/` and the discovery walks both roots. For Phase 2, only engine-side plugins exist, so only the engine path matters.

**`src/agents/agent-runner.ts` — lines 641-642**

```ts
// Before
const npmPath = resolve(hiveHome, "plugins", "node_modules", plugin.name, ...);
const inTreePath = resolve(hiveHome, "plugins", plugin.name, ...);

// After
const npmPath = resolve(engineDir, "plugins", "node_modules", plugin.name, ...);
const inTreePath = resolve(engineDir, "plugins", plugin.name, ...);
```

**`src/cli/plugin.ts` — line 11**

```ts
// Before
const pluginsDir = resolve(hiveHome, "plugins");

// After
const pluginsDir = resolve(engineDir, "plugins");
```

Phase 2 only touches *engine-side* plugin management. Instance-authored plugins at `<hiveHome>/plugins/` (Phase 1's reserved sibling) are out of scope for `hive install plugin` today; that's a later commercialization concern.

**`src/cli/daemon.ts` — plist generation**

The LaunchAgent plist's `ProgramArguments` and `WorkingDirectory`:

```ts
// Before
const serverPath = existsSync(resolve(pkgRoot, "pkg", "server.min.js"))
  ? resolve(pkgRoot, "pkg", "server.min.js")
  : resolve(pkgRoot, "dist", "index.js");
// ... plist uses `serverPath`, WorkingDirectory = hiveHome
```

```ts
// After
const serverPath = existsSync(resolve(engineDir, "pkg", "server.min.js"))
  ? resolve(engineDir, "pkg", "server.min.js")
  : resolve(engineDir, "dist", "index.js");
// ... plist still uses serverPath (now absolute into .hive/), WorkingDirectory = hiveHome (unchanged)
```

Behavioral note: `cli.ts` passes `PKG_ROOT = resolve(import.meta.dirname, "..")` as `pkgRoot` into `startDaemon()`. After Phase 2, `import.meta.dirname` for compiled `cli.js` is `<instance>/.hive/dist/`, so `PKG_ROOT` already resolves to `<instance>/.hive/` — functionally equivalent to `engineDir`. Switching to explicit `engineDir` is a clarity fix, not a behavior change. The switch still matters because it lets us drop the `pkgRoot` parameter from `startDaemon` and read `engineDir` directly from `paths.ts`, which is more consistent with how the rest of the codebase references engine paths.

Keeping `WorkingDirectory = hiveHome` matters — that's the instance root, which is what Phase 1 derived agent cwds from. The node process runs from the instance dir; only its entry script is inside `.hive/`.

Generated plist stays at `<hiveHome>/service/<label>.plist` (instance root). This is deliberate — the `~/Library/LaunchAgents/` symlink points here, and this file must survive `.hive/` wipe. The engine *scripts and templates* (`deploy.sh`, `install.sh`, hand-authored example plists) move into `.hive/service/`; the *generated live plist* stays at `<instance>/service/`.

**Hand-authored vs generated plists — two distinct artifacts.** The repo's `service/com.hive.personal.agent.plist` is a hand-authored example plist used by the multi-instance setup (the "personal" instance piggybacks on dodi's install). This is an engine artifact — it ships in the tarball at `.hive/service/` and is never the live plist. It acts as a template/reference; actual live plists at `<instance>/service/<label>.plist` are regenerated by `hive daemon start` (current) or the equivalent Phase 3/4 CLI. For Phase 2, the hand-authored file needs one edit: `ProgramArguments` `dist/index.js` → `.hive/dist/index.js`. Its `WorkingDirectory` stays at `/Users/mokie/services/hive` (the instance root) — the relative path under that working dir lands on the correct entry.

**`src/paths.ts` — pkg root detection**

`cli.ts:100`: `const PKG_ROOT = resolve(import.meta.dirname, "..")` — resolves to the engine root (compiled dist parent). After the move, `PKG_ROOT` naturally becomes `.hive/` without code change. No action needed.

### Config file changes

**`hive.yaml.example`** — no schema changes; only examples/comments that reference `plugins/claude-code/` rewrite to `.hive/plugins/claude-code/`. Real instance `hive.yaml` files with explicit `codeTask.pluginDirs` paths pointing at the old `plugins/` location will break on the first 0.2.0 boot; **Phase 5's migration script rewrites those paths as part of the cutover**. Phase 2 does *not* ship a grace-period fallback — keeping the path resolution strict means a misaligned `pluginDirs` fails loudly at startup (no plugin dir found), which is what we want: no silent half-migration.

**`service/instances.conf`** — unchanged for Phase 2 (the file's format doesn't reference engine paths). Gets reconsidered entirely in Phase 3.

**`service/deploy.sh`** — minimal path updates:
- `rsync -a --delete "$BUILD_DIR/dist/" "$DEPLOY_DIR/dist/"` → `"$DEPLOY_DIR/.hive/dist/"`
- Same for `plugins/claude-code/`
- `cd "$DEPLOY_DIR" && git pull` — *unchanged* in Phase 2 (git-pull retirement is Phase 3)

Phase 2 keeps `deploy.sh` working end-to-end with the new layout. The wholesale rewrite is Phase 3.

**`service/com.hive.personal.agent.plist`** — hand-authored plist file for the additional `personal` instance on this machine. Update `ProgramArguments` to `.hive/dist/index.js`. (This file is engine-shipped; lives at `.hive/service/` after the move.)

### Migration hook (Phase 2 only — fresh installs)

Phase 2 ships with only the new layout. Existing running instances (dodi, keepur) keep running 0.1.x until Phase 5 migrates them. No code in Phase 2 needs to handle the old layout — if you extract a 0.2.0 tarball over a 0.1.x instance, you'll have a broken install, and that's fine: nobody's supposed to do that until Phase 5 ships.

For safety, we add one check at engine startup: if `<hiveHome>/dist/index.js` exists AND `<hiveHome>/.hive/dist/index.js` also exists, log a loud warning and exit. This catches the "botched manual upgrade" case where someone extracted a 0.2.0 tarball but left the old `dist/` behind. The check lives in `src/index.ts` next to the integrity verification.

### Build output changes

The engine repo itself (at `~/github/hive/`) does NOT change layout. Dev mode keeps working exactly as today. What changes is the *deployed* layout. The build output (`~/build/hive/dist/`, etc.) is unchanged; the deploy step places it under `.hive/` instead of at the instance root.

One knock-on: dev mode runs from `~/github/hive/` where `dist/` is at the repo root. When someone runs `npm run dev` or similar, `import.meta.dirname` resolves from dev's `src/` dir, and `seedsDir = resolve(import.meta.dirname, "..", "seeds")` correctly resolves to `~/github/hive/seeds/`. No dev-mode regression.

## Files touched

### Code

- `src/paths.ts` — add `engineDir`, rename `hiveMetaDir` → `hiveStateDir`, repoint.
- `src/index.ts` — import swap; rename parameter on 2-3 function calls.
- `src/config.ts` — plugin discovery root switches to `engineDir`.
- `src/agents/agent-runner.ts` — engine plugin path resolution at lines 641-642.
- `src/cli/plugin.ts` — `pluginsDir` uses `engineDir`.
- `src/cli/daemon.ts` — plist's `serverPath` reads from `engineDir`.
- `src/skills/integrity.ts`, `upgrade-notice.ts`, `instance-git.ts` — parameter rename.

### Config / scripts

- `hive.yaml.example` — update example paths (no schema change).
- `service/deploy.sh` — path updates only (full rewrite is Phase 3).
- `service/com.hive.personal.agent.plist` — `ProgramArguments` update.

### Tests

- `src/paths.test.ts` — add assertions that `engineDir` resolves to `<hiveHome>/.hive`, `hiveStateDir` to `<hiveHome>/.hive-state`, `instanceGitDir` to `<hiveHome>/.hive-state/git`.
- `src/cli/daemon.test.ts` — update expected plist `ProgramArguments` path to `<hiveHome>/.hive/dist/index.js`; assert `WorkingDirectory` still at instance root.
- `src/skills/integrity.test.ts` — update fixtures to pass `hiveStateDir` path. Add a test that `writeSnapshot` writes to its `stateDir` parameter (not derived from `packageRoot`). Remove any assertions tied to the deleted `PACKAGE_PATHS` set.
- `src/skills/upgrade-notice.test.ts` — update fixture paths to `.hive-state/`.
- `src/skills/instance-git.test.ts` — update fixtures to point at `<tmp>/.hive-state/git/` instead of `<tmp>/.hive/git/`. Cover all six ex-hardcoded call sites.

### Not touched in Phase 2

- Fresh customer install flow (Phase 4).
- `deploy.sh` rewrite to retire git-pull + skill auto-commit (Phase 3).
- Migration script for existing 0.1.x instances (Phase 5).
- `src/archetypes/*` — no changes.

## Runtime failure modes

1. **Dev mode picks up a stale `~/github/hive/.hive/dist/index.js`.** Won't happen — dev runs from the repo root using `tsx`, which imports TS source directly. No `.hive/` ever gets created in a dev checkout unless someone manually `cp`s it there.

2. **`.hive-state/git/` rename during a running process.** Instance-git is a per-call feature; the rename is atomic at code-change time (new callers write to new path). Old `.hive/git/` remnants are harmless unused dirs after the cutover — Phase 5 migration cleans them up.

3. **Stale plist pointing at `<hiveHome>/dist/index.js` survives upgrade.** Operator ran the 0.2.0 engine but didn't regen the plist. We don't auto-regen on every start (the plist should be stable). Mitigation: the `hive doctor` CLI (existing `src/cli/doctor.ts`) gets one extra check — if the live plist's `ProgramArguments` doesn't match the expected engine path, warn with "run `hive daemon start` to refresh".

4. **Two `dist/index.js` coexist.** The startup check (from "Migration hook" above) catches this and refuses to boot.

## Acceptance

- **Fresh-install test**: Create an empty `<instance>/` dir with a minimal `hive.yaml` + `.env`. Extract a tarball built from this branch into `<instance>/.hive/`. Run `hive daemon start` — launchd loads, logs emit `"Hive is running"`, agents respond on Slack.
- **Upgrade test**: On a healthy instance running the new layout, `rm -rf <instance>/.hive && tar -xzf @keepur-hive-<newer-tag>.tgz -C <instance>/.hive && launchctl kickstart -k gui/$(id -u)/com.hive.<id>.agent`. Instance boots, passes health check, `logs/` has no errors, all agents respond.
- **Preserve test**: In the upgrade above, assert `agents/`, `logs/`, `.env`, `hive.yaml`, `.hive-state/` are byte-identical before and after. `<hiveHome>/service/<label>.plist` is unchanged.
- **Independent-upgrade test**: On a machine with both dodi and keepur instances in the new layout, extract a `v0.2.1` tarball into only dodi's `.hive/`. Dodi runs 0.2.1; keepur stays on 0.2.0. Both healthy.
- **Dev-mode test**: `npm run dev` inside `~/github/hive/` still works; seed paths resolve; plugin discovery finds engine plugins; no regression vs. 0.1.x dev experience.

## Open questions

None. State-dir renamed to `.hive-state/`. Generated plist stays at `<instance>/service/`. Engine path switch is code-change-only; no in-place migration needed for fresh installs. `instance-git.ts` uses a `paths.ts`-exported `instanceGitDir` constant rather than threading a parameter through every function signature.
