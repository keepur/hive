# Deploy Flow Rewrite — Design Spec

**Date**: 2026-04-21
**Ticket**: [KPR-53](https://linear.app/keepur/issue/KPR-53) (Phase 3 of [KPR-50](https://linear.app/keepur/issue/KPR-50) — Instance dir restructure, v0.2.0)
**Depends on**: [KPR-52](https://linear.app/keepur/issue/KPR-52) (Phase 2 — engine relocated into `.hive/`)
**Status**: Draft

## Problem

Today's `deploy.sh` treats the instance dir as a git clone of the `deploy` branch:

- Line 105-106: `cd "$DEPLOY_DIR"; PREV_SHA=$(git rev-parse --short HEAD)` — reads current deployed SHA from the instance's `.git/`
- Lines 115-158: the skill auto-commit block (stash / fetch main / checkout main / pull / pop / commit / push / checkout back)
- Line 163: `git pull --ff-only` inside `$BUILD_DIR` (the build tree) — this is a legitimate git pull and stays
- Line 189: `git pull --ff-only` inside `$DEPLOY_DIR` (the instance dir) — this is the one we retire
- Line 190: `npm install --omit=dev` inside the instance dir
- Lines 194-195: `rsync -a --delete "$BUILD_DIR/dist/" "$DEPLOY_DIR/dist/"` and the same for `plugins/claude-code/`

Two consequences:

1. **Instance dirs carry git state.** Every instance is a full clone of `keepur/hive` on the `deploy` branch. Branch drift between instances isn't modeled — dodi and keepur are both "on `deploy`" regardless of which version each actually wants to be running.

2. **The skill auto-commit hack** (`deploy.sh:112-156`, flagged by May per `feedback_deploy_skill_autocommit.md`). Because `skills/` lives inside the instance git clone, agent-authored skill edits show up as uncommitted changes. Before `git pull`, the script stashes them, checks out `main`, pulls, pops the stash, commits to `main`, pushes to `origin/main`, and checks back out to the deploy branch. Any failure midway leaves the tree in a half-rebased state. This is the biggest wart in the current flow.

Phase 2 moved engine contents into `.hive/`. Phase 3 retires the git-clone-as-instance-dir pattern and the skill auto-commit hack that only existed because of it.

## Goal

After Phase 3:

- `deploy.sh` never runs `git pull` against the instance dir.
- `<instance>/.hive/` is the only thing that changes on deploy (wipe-and-replace).
- `<instance>/skills/` is instance-authored, lives at instance root, survives upgrades, and is never committed by Hive. The auto-commit hack is gone.
- A rollback to the previous engine version is a single command.
- dodi and keepur can pin independent versions.

Non-goals: changing the beta-customer install path (Phase 4), migrating existing 0.1.x instances (Phase 5), changing how the build dir itself is sourced.

## Design

### Engine source: npm tarball, fallback rsync

Two supported sources for the new `.hive/` contents, both supported by the same rewrite:

**Primary (shipped customers / production deploys)**: `npm pack @keepur/hive@<tag>` fetches a tarball from the public registry, which extracts flat into `.hive/`:

```
<instance>/.hive/
  pkg/
    server.min.js          ← ProgramArguments target
    cli.min.js
  seeds/
  templates/
  scripts/
  package.json             ← the published package's manifest
```

This matches the existing `files` field in the repo's `package.json` (`pkg/`, `seeds/`, `templates/`, `scripts/honeypot`). The daemon's `serverPath` detection after Phase 2 reads from `engineDir` (which resolves to `<instance>/.hive/`) and prefers `pkg/server.min.js` over `dist/index.js`. Since Phase 3 populates `.hive/` with `pkg/server.min.js` (the npm-pack shape), the daemon finds it on the preferred path with no additional code change beyond Phase 2's existing `pkgRoot` → `engineDir` rewrite. If Phase 2 shipped before Phase 3 and someone's running a dev install with `dist/` at `.hive/dist/`, the fallback at `daemon.ts` line 40 still works.

Install mechanics:

```bash
# TAG may arrive with or without leading 'v' (matches instances.conf convention).
# npm uses bare semver, so strip the prefix before every npm call.
TAG="${1:-latest}"
NPM_VERSION="${TAG#v}"

TARBALL=$(npm pack "@keepur/hive@$NPM_VERSION" | tail -n1)
mkdir -p "$DEPLOY_DIR/.hive.next"
tar -xzf "$TARBALL" --strip-components=1 -C "$DEPLOY_DIR/.hive.next/"
rm -f "$TARBALL"

# Swap: the old .hive becomes .hive.prev; the new .hive.next becomes live.
if [[ -d "$DEPLOY_DIR/.hive" ]]; then
  rm -rf "$DEPLOY_DIR/.hive.prev"              # drop the older backup
  mv "$DEPLOY_DIR/.hive" "$DEPLOY_DIR/.hive.prev"
fi
mv "$DEPLOY_DIR/.hive.next" "$DEPLOY_DIR/.hive"
```

Rotation policy: at any time we retain at most `<.hive>` (live) and `<.hive.prev>` (one step back). Deeper history is npm registry's job — any prior tag can be re-fetched.

Rationale for `npm pack` over `npm install @keepur/hive`: `npm install` lands content at `node_modules/@keepur/hive/...`, which adds a layer of nesting. The deployed layout in the KPR-50 spec has the engine flat inside `.hive/`, not behind a `node_modules/` indirection. `npm pack` + tarball extract gives us the flat form.

**Fallback (dev / internal deploys from `~/build/hive`)**: rsync from the build dir, targeting the same flat layout:

```bash
# No nesting — mirrors the npm pack shape
rsync -a --delete "$BUILD_DIR/pkg/"       "$DEPLOY_DIR/.hive.next/pkg/"
rsync -a --delete "$BUILD_DIR/seeds/"     "$DEPLOY_DIR/.hive.next/seeds/"
rsync -a --delete "$BUILD_DIR/templates/" "$DEPLOY_DIR/.hive.next/templates/"
rsync -a --delete "$BUILD_DIR/scripts/"   "$DEPLOY_DIR/.hive.next/scripts/"
cp "$BUILD_DIR/package.json" "$DEPLOY_DIR/.hive.next/"
# Same swap sequence as npm pack path
```

The fallback requires `npm run bundle` (not just `npm run build`) to have produced `pkg/` in the build dir. If `pkg/` is absent, deploy falls back further to `dist/` + `node_modules/` — the 0.1.x shape — for dev continuity. The spec treats this as a developer ergonomics fallback, not a production path.

### Rollback via directory swap

`<instance>/.hive` is the live engine; `<instance>/.hive.prev` is the previous version retained for rollback. One command to roll back:

```bash
hive rollback --instance=<id>   # or: ./deploy.sh --rollback --instance=<id>
# which does:
if [[ ! -d <instance>/.hive.prev ]]; then
  echo "ERROR: no previous engine to roll back to (.hive.prev missing)" >&2
  exit 1
fi
mv <instance>/.hive <instance>/.hive.broken
mv <instance>/.hive.prev <instance>/.hive
launchctl kickstart -k gui/$(id -u)/com.hive.<id>.agent
# leave .hive.broken on disk for one cycle so an operator can inspect
# the failed version; next successful deploy will rotate it out.
```

**The `.hive.prev`-missing guard is load-bearing**: during the Phase 5 cutover window, a freshly-migrated instance has `.hive/` but no `.hive.prev/` (the migration creates the new layout but does not seed a backup). Attempting auto-rollback in that state without the guard would leave the instance with no engine at all. The same guard must appear in both the manual-rollback path (above) and the auto-rollback path in `deploy.sh` step 8.

**Why directory swap, not symlink swap.** The ticket mentions "`.hive` ↔ `.hive.prev` symlink swap" as an option. `<instance>/.hive` as a symlink would let rollback be one `ln -sf`, but it introduces cross-filesystem quirks and makes the `resolveHiveHome` / `engineDir` resolution subtly different in dev vs. prod (real dir vs. symlinked dir can behave differently under `fs.realpathSync`). Directory swap with `mv` is atomic on a single filesystem, never has a stale symlink, and works identically in dev and prod. This is what the spec prescribes.

One cost: during the swap, there's a ~50ms window where `.hive` doesn't exist. The launchd-managed agent process has already been stopped (see "Deploy ordering" below), so nothing's reading from `.hive` during the gap.

### Skill auto-commit hack — deleted

`deploy.sh:112-158` (the stash/checkout/pull/pop/commit/push dance for `skills/`) goes away entirely. After Phase 2:

- `<instance>/skills/` is instance-authored content at instance root.
- The instance dir is not a git clone — there's no index to dirty.
- `skills/` survives every `.hive/` wipe by construction.

Skill edits made by agents persist at their intended location until the operator chooses to promote them into the engine's shipped skills (which is a separate, manual flow — editing `src/skills/` in the upstream repo, shipping in a new release). Auto-promotion from instance to upstream main is gone.

### Git state removal in instance dirs

After Phase 3, `<instance>/.git/` is unused. The fresh-install path (Phase 4) never creates it. The migration path (Phase 5) deletes the existing `.git/` dir as part of the cutover. Phase 3 itself does *not* delete `.git/` — the deploy-script rewrite is a pure behavior change. Existing instances with a stale `.git/` keep working through Phase 3 because nothing reads from it.

### Deploy ordering (per instance)

The per-instance step sequence in `deploy.sh`:

1. Pre-flight: verify target tag is installable (either `npm view @keepur/hive@<tag>` succeeds, or `$BUILD_DIR/pkg/server.min.js` exists for the fallback path).
2. Stop the instance: `launchctl kickstart -kp ...` → allow graceful exit.
3. Ensure ports are free: `kill_ports` (existing helper).
4. Extract new engine into `.hive.next/` (side dir, no impact on live state).
5. Swap: `mv .hive .hive.prev && mv .hive.next .hive`.
6. Restart: `launchctl kickstart -k gui/$(id -u)/<label>`.
7. Health check: tail the log for `"Hive is running"` within 30s (existing `health_check` helper).
8. On failure, auto-rollback: swap `.hive ↔ .hive.prev` and restart again. Notify Slack.

Steps 2-3 are currently implicit (`kickstart -k` restarts with a kill signal). Making them explicit preserves the contract that "nothing is reading from `.hive/` during the swap."

### Multi-instance sequencing

Current behavior: sequential across instances, with health-check gating between each. If instance N fails health check, the script logs it and continues with instance N+1, reporting all failures at the end. Phase 3 keeps this.

No parallel deploys. The build step is shared (one build, many deploys), but each instance's engine swap is serial. Rationale:

- Failures are rare, but when they happen we want one to fix rather than three in flight.
- The machine is a single Mac Mini — shared CPU/disk/MongoDB — so "parallel" gains little in wall-clock.
- Dodi and keepur still pin independent versions via config (see below), so parallel isn't needed to get per-instance agility.

### Per-instance version pinning

`instances.conf` gains a new column: the engine tag to deploy for that instance. Format (backward-compatible — missing column defaults to "latest published"):

```
# INSTANCE_ID|HIVE_CONFIG|_|LAUNCHAGENT_LABEL|LOGS_DIR|PORTS|ENGINE_TAG
dodi|hive.yaml|-|com.hive.agent|logs|3100 3200|v0.2.0
keepur|hive-keepur.yaml|-|com.hive.keepur.agent|logs-keepur|3300 3303|v0.1.10
```

`deploy.sh` reads `ENGINE_TAG` per instance; defaults to `$DEFAULT_TAG` (env var or first-line tag in `tags.txt`, to be decided in Phase 4 — for Phase 3 the default is `v0.2.0`). With this change, a dodi 0.2.x upgrade never touches keepur's `.hive/` dir.

**Update the `instances.conf` parser in `deploy.sh` line 26** to read the new column — the existing 6-field IFS read silently swallows the 7th column into `ports`, which would break `kill_ports`. The new read:

```bash
while IFS='|' read -r id config _agents_path label logs_dir ports engine_tag; do
  [[ "$id" =~ ^[[:space:]]*# ]] && continue
  [[ -z "$id" ]] && continue
  id=$(echo "$id" | xargs)
  config=$(echo "$config" | xargs)
  label=$(echo "$label" | xargs)
  logs_dir=$(echo "$logs_dir" | xargs)
  ports=$(echo "$ports" | xargs)
  engine_tag=$(echo "${engine_tag:-}" | xargs)     # optional — empty means "latest"
  INSTANCES+=("$id|$config|$label|$logs_dir|$ports|$engine_tag")
done < "$INSTANCES_CONF"
```

Downstream consumers of `INSTANCES[@]` must likewise be updated to expect 6 pipe-separated fields (id, config, label, logs_dir, ports, engine_tag) instead of 5.

For Phase 3, the feature is present in code but exercise is minimal — both dodi and keepur ride the same tag through the migration window. Phase 5 is where independent pinning gets real use. Ship it in Phase 3 so Phase 5 doesn't have to retrofit it under time pressure.

### `deploy-check.sh` — pinning-aware version compare

Current `deploy-check.sh` polls `origin/deploy` in `$BUILD_DIR` and compares SHAs. After Phase 3, "is there a new version" is a per-instance question — dodi pinned to `0.2.0` and keepur pinned to `0.1.10` are *both* up to date even though `npm view @keepur/hive version` (which returns `latest`) would disagree for at least one of them.

The replacement must read each instance's pinned tag from `instances.conf` and compare against that:

```bash
# Path model:
#   $DEPLOY_DIR is the primary instance dir (dodi today) — unchanged from 0.1.x.
#   deploy-check.sh + deploy.sh + instances.conf all live inside .hive/service/
#   after Phase 2 (they're engine-shipped). deploy-check.sh finds deploy.sh as a
#   sibling in its own directory. Secondary instances (keepur, personal) use
#   the primary's copies — they don't need their own orchestrator.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

for inst in "${INSTANCES[@]}"; do
  # instances.conf has 7 columns: ID|CONFIG|(placeholder "-")|LABEL|LOGS|PORTS|TAG
  IFS='|' read -r id _config _placeholder _label _logs _ports engine_tag <<< "$inst"
  TAG="${engine_tag:-latest}"
  PINNED_VERSION="${TAG#v}"  # strip leading v — npm uses bare semver
  INSTANCE_ROOT="$DEPLOY_DIR/$id"     # for "dodi", this collapses back to $DEPLOY_DIR
  CURRENT=$(jq -r .version < "$INSTANCE_ROOT/.hive/package.json" 2>/dev/null || echo "unknown")

  if [[ "$TAG" == "latest" ]]; then
    TARGET=$(npm view @keepur/hive version)          # the 'latest' dist-tag
  else
    TARGET=$(npm view @keepur/hive@$PINNED_VERSION version)  # exact-version query
  fi

  [[ "$CURRENT" == "$TARGET" ]] && continue
  # Up-to-date check failed: invoke per-instance deploy. deploy.sh is the sibling
  # script inside the primary instance's .hive/service/ and handles one instance
  # per invocation via --instance.
  "$SCRIPT_DIR/deploy.sh" --instance="$id" --tag="$TARGET"
done
```

**Path model clarification** (load-bearing for both `deploy.sh` and `deploy-check.sh`):

- `$DEPLOY_DIR` stays defined as today (`~/services/hive/`), i.e. the **primary instance root** (dodi). This is unchanged from 0.1.x.
- After Phase 2, both scripts live at `$DEPLOY_DIR/.hive/service/deploy.sh` and `$DEPLOY_DIR/.hive/service/deploy-check.sh` (engine-shipped).
- `instances.conf` also moves to `$DEPLOY_DIR/.hive/service/instances.conf` (engine-shipped — operator edits happen via `hive install instance` flows per Phase 4, not by hand; machine-specific configs land via the Phase 5 migration).
- Secondary instances (keepur, personal) each live under `$DEPLOY_DIR/<id>/` and use the primary's scripts. The LaunchAgent running `deploy-check.sh` points at the primary's copy only.
- `SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"` at the top of both scripts (already present in today's `deploy.sh` line 9) ensures the scripts find their siblings without hardcoded absolute paths.

Two subtle points:

1. **`v`-prefix handling.** Package versions in npm are bare semver (`0.2.0`). Human-facing labels — git tags, release notes, the `instances.conf` column — conventionally use `v0.2.0`. The `ENGINE_TAG` column accepts either form; the script strips any leading `v` before handing to npm. `hive rollback` and `hive update --tag=...` do the same.
2. **"latest" as the implicit default.** When `instances.conf` has no `ENGINE_TAG` column (backward compat with pre-0.2.0 setups), the script treats it as "latest" and queries the `latest` dist-tag. This gives "autoupgrade to the latest published" semantics for instances that don't opt into pinning. Explicit tag wins over `latest`.

The outer loop (LaunchAgent, every 15 min) is unchanged — only the per-instance compare logic changes.

## Files touched

### Code / scripts

- `service/deploy.sh` — major rewrite.
  - Delete lines 105-106 (reading `PREV_SHA` from the instance dir's git) — replace with `PREV_VERSION=$(jq -r .version < "$DEPLOY_DIR/.hive/package.json" 2>/dev/null || echo "unknown")`.
  - Delete lines 115-158 (the entire skill auto-commit block).
  - Delete lines 188-190 (the instance-dir `git pull --ff-only` and `npm install --omit=dev` inside `$DEPLOY_DIR`) — the instance dir has no deps to install.
  - Keep line 163 (`git pull --ff-only` in `$BUILD_DIR`) — the build tree is still a git clone, still pulled before building.
  - Replace lines 194-195 (rsync dist/ and plugins/claude-code/ directly into instance root) with the new `fetch_engine()` flow that stages into `.hive.next/` and swaps.
  - Add new helpers: `fetch_engine()`, `swap_engine()`, `rollback_engine()`.
- `service/deploy-check.sh` — SHA compare replaced with version compare.
- `service/instances.conf` — new `ENGINE_TAG` column. Update comment block at top.
- `service/install.sh` — no changes in Phase 3 (Phase 4 revisits the fresh-install path).
- `src/cli/update.ts` (existing) — rewrite `runUpdate` to shell out to `deploy.sh` (with `--tag=<tag>` and optional `--instance=<id>`) rather than the current `npm update -g @keepur/hive` call. Add a new exported `runRollback()` that shells out to `deploy.sh --rollback --instance=<id>`. The shell script remains the single source of truth for the swap logic; the CLI is a thin typed wrapper.
- `src/cli.ts` — register the new `rollback` command. Current switch arms include `case "update"` but no `case "rollback"`; add one that imports and invokes `runRollback`. Update the `--help` output to list `rollback` alongside `update`.

### Config / docs

- `package.json` — ensure `files` field matches what `npm pack` produces for the new layout. Current field (`pkg/`, `seeds/`, `templates/`, `scripts/honeypot`) is already correct. No change.
- `docs/deployment.md` (create) — document the new deploy flow: source of engine, rollback, per-instance pinning.

### Tests

- `service/deploy.test.sh` (new) — smoke test script that exercises `fetch_engine`, `swap_engine`, `rollback_engine` against a scratch temp dir. Not unit tests in the TS sense; this is a shell-script test harness using `bats` or a lightweight `set -e` sequence.
- `src/cli/update.test.ts` — test the new `hive update` / `hive rollback` CLI wiring (existing test file, extend).

### Not touched in Phase 3

- `src/*` outside `cli/update.ts` — engine code is layout-stable after Phase 2. Phase 3 is deploy-mechanics-only.
- Fresh-install path / `install.sh` / bootstrap script (Phase 4).
- Existing instance migration (Phase 5).
- CI publish workflow (`.github/workflows/publish.yml`) — unchanged. Same package, same publish, just consumed differently downstream.

## Runtime failure modes

1. **`npm pack` fails (network, registry outage, tag not yet published).** Deploy aborts before any swap happens. Live `.hive/` unchanged. Slack notification; retry-after-manual-fix is the recovery path.
2. **Tarball extract fails mid-stream.** Corrupt `.hive.next/` is discarded (`rm -rf .hive.next`), live `.hive/` unchanged.
3. **Swap succeeds but health check fails.** Auto-rollback: swap `.hive ↔ .hive.prev`, restart. Slack notification: "Deploy rolled back from `<tag>` to `<prev-tag>` on instance `<id>` — health check failed."
4. **Health check passes but runtime errors within first hour.** Operator runs `hive rollback` manually. No automation past the first-30-seconds health window; runtime-stability detection would be a separate observability feature.
5. **`.hive.prev` doesn't exist (first deploy after fresh install, or just-migrated instance post-Phase-5).** Rollback is unavailable. The deploy-script guard in step 8 checks `[[ -d .hive.prev ]]` before the auto-rollback swap; if absent, the script logs `"auto-rollback unavailable: no previous engine"` to Slack and leaves the (failed) engine in place for operator inspection. The operator's options are: (a) reinstall the previous tag manually (`deploy.sh --tag=<prev-version>`), (b) debug `.hive/` in place, (c) restore from the `.pre-0.2-bak` snapshot that Phase 5's migration creates.
6. **Operator hand-edited something inside `.hive/`.** Lost on next deploy. This is by design — `.hive/` is engine-owned. The warning in the "Migration hook" (from Phase 2) catches some of this at boot.

## Acceptance

- **No git-pull in deploy-dir path**: `grep -n "git pull" service/deploy.sh` shows exactly one match, and it targets `$BUILD_DIR` (the legitimate build-dir pull). No `git pull` under `$DEPLOY_DIR`.
- **Skill auto-commit gone**: lines 112-158 in the old `deploy.sh` are removed. Agent-edited files in `<instance>/skills/` survive a deploy without any git commits landing on `keepur/hive:main`.
- **Rollback works**: deploy `v0.2.1` to a healthy `v0.2.0` instance. Run `hive rollback`. Instance is running `v0.2.0` again within the health-check window. Post-rollback state on disk: `.hive/` is `v0.2.0` (restored from the former `.hive.prev/`), `.hive.broken/` is `v0.2.1` (left for operator inspection), `.hive.prev/` is absent. The next successful deploy rotates `.hive.broken/` out (`rm -rf .hive.broken`) and produces a fresh `.hive.prev/`.
- **Per-instance pinning**: `instances.conf` with `dodi|...|v0.2.1` and `keepur|...|v0.2.0`. Deploy runs on both. Dodi's `.hive/package.json` has `version: 0.2.1`; keepur's has `0.2.0`. Both healthy.
- **Auto-rollback on health failure**: Mock a broken `.hive/` (e.g., `mv .hive.next/pkg/server.min.js ...bad`). Deploy swaps in the broken engine, health check times out, auto-rollback fires, instance is healthy on the previous version. Slack notified.
- **Repeat upgrade leaves exactly one backup**: After three consecutive deploys (`v0.2.0` → `v0.2.1` → `v0.2.2`), `<instance>/` has `.hive/` (v0.2.2) and `.hive.prev/` (v0.2.1) only. No `.hive.prev.prev/` lingers.

## Entry points — one source of truth

Both `hive update` (typed CLI, from `src/cli/update.ts`) and the LaunchAgent-triggered `deploy-check.sh` → `deploy.sh` flow converge on the same shell script. `deploy.sh` owns the actual fetch/swap/restart/health-check logic; the TypeScript `runUpdate` and `runRollback` in `update.ts` are thin wrappers that shell out with the appropriate flags:

```ts
// update.ts — simplified
export async function runUpdate(opts: { tag?: string; instance?: string }) {
  const deployScript = resolve(engineDir, "service/deploy.sh");
  const args = ["--tag", opts.tag ?? "latest"];
  if (opts.instance) args.push("--instance", opts.instance);
  execFileSync(deployScript, args, { stdio: "inherit" });
}
```

This avoids having two implementations of the swap logic drift. `update.ts`'s existing `npm update -g @keepur/hive` call is removed — that command targeted the global install model that Phase 3 is replacing.

## Open questions

None. Primary source is npm tarball extraction (flat into `.hive/`); build-dir rsync is the fallback for internal/dev deploys. Rollback is directory swap, not symlink. Per-instance tag pinning lands in Phase 3 via a new column in `instances.conf`. `deploy.sh` is the single implementation of fetch/swap/rollback; `hive update` and `hive rollback` are CLI wrappers around it. Instance `.git/` removal defers to Phase 5 cutover; Phase 3 just stops writing to it.
