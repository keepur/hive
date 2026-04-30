# Hive 0.2.0 — Instance layout restructure

**Release date:** TBD
**Breaking change:** yes — new instance directory layout. Existing installs need a one-shot migration.

## What's new

- **New layout**: engine lives in `<instance>/.hive/`; config, logs, agent data, skills live at instance root.
- **`hive update`** now does atomic engine swap: fetches npm tarball, extracts into `.hive.next/`, swaps with `.hive/`, restarts. Auto-rollback on health failure.
- **`hive rollback`**: one-command restore of the previous engine from `.hive.prev/`.
- **Per-instance version pinning** via new `ENGINE_TAG` column in `instances.conf`. Any multi-instance setup can ride different versions independently.
- **Skill auto-commit hack removed**: `skills/` is instance-authored, survives upgrades, never touched by the deploy script.
- **Retention sweeper** (from 0.1.11 / KPR-51): ships as dry-run-only in 0.2.0. Reports age-over files to your Slack audit channel; flip `retention.enabled: true` in `hive.yaml` when ready.

## Breaking changes

- `<instance>/` is no longer a git clone. Existing `.git/` directories are removed by the migration script.
- `<instance>/dist/`, `<instance>/node_modules/`, `<instance>/src/` are gone — everything moves to `<instance>/.hive/`.
- `hive.yaml` `codeTask.pluginDirs` paths are rewritten by the migration from `~/services/hive/plugins/claude-code/` to `<instance>/.hive/plugins/claude-code/`.
- The LaunchAgent plist's `ProgramArguments` changes from `<instance>/dist/index.js` to `<instance>/.hive/pkg/server.min.js`.
- **Legacy launchd label rename**: pre-0.2.0 single-instance installs used the label `com.hive.agent`. The migration renames any such label to `com.hive.<instance-id>.agent` to align with the convention every fresh 0.2.0 install already uses. The migration retires the old label (bootout + symlink delete) before bringing up the new one. If your monitoring, dashboards, or `launchctl list` scripts reference `com.hive.agent`, update them post-migration.

## Migrating from 0.1.x

See [Migrating to 0.2.0](./migrating-to-0.2.md) for the full walkthrough.

TL;DR:

```bash
curl -fsSL https://raw.githubusercontent.com/keepur/hive/main/install/migrate-0.2.sh \
  | bash -s -- ~/services/hive/<your-instance>
```

Dry-run first (`--dry-run` before the instance path) to preview the file classification.

**Downtime**: ~5 minutes per instance. The migration stops the LaunchAgent, relocates files, installs 0.2.0, and restarts.

## Rolling back

If something goes wrong during migration, the script auto-rolls-back from the `.pre-0.2-bak/` snapshot. If you need to roll back to 0.1.x after a successful migration, restore the snapshot manually and pin `v0.1.10` in `instances.conf`.

Once you're on 0.2.0, rolling *engine versions* (e.g., 0.2.1 → 0.2.0) is a single command: `hive rollback`.

## Known issues / gotchas

- `yq` and `jq` are now hard deps for the migration script. Install via `brew install yq jq` first.
- Instances that shared a `HIVE_HOME` in 0.1.x get migrated together — migrating one simultaneously migrates the layout for any sibling that shared the directory. Both come back online under the new engine.
- Loose files that don't match the classifier's known prefixes land in `data/archive-pre-0.2/unsorted/`. Review and re-home as you like.
