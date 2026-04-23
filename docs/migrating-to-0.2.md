# Migrating to Hive 0.2.0

Hive 0.2.0 ships a new instance directory layout. The engine now lives in `<instance>/.hive/` (wipe-and-replace on upgrade); your config, logs, agent data, and skills stay at the instance root.

Existing 0.1.x installs need a one-shot migration to the new layout. This page walks through it.

## Before you start

- **Back up MongoDB** (or verify your regular backups are recent). The migration does not touch MongoDB, but a belt-and-braces snapshot before any layout change is cheap insurance.
- **Stop any in-flight agent work** you care about. The migration stops the LaunchAgent for ~5 minutes; threads in flight will interrupt and resume on restart (the 60s Slack dedup catches pending messages).
- **Free disk**: you need ~2× your instance dir size (for the rollback snapshot).
- **Install `yq` and `jq`** via Homebrew if you haven't:
  ```bash
  brew install yq jq
  ```

## Run the migration

```bash
curl -fsSL https://raw.githubusercontent.com/keepur/hive-docs/main/install/migrate-0.2.sh \
  | bash -s -- ~/services/hive/<your-instance>
```

Replace `<your-instance>` with the folder name (e.g., `dodi`, `keepur`). The script:

1. Preflights your instance (checks for a valid 0.1.x layout, disk space, required CLIs).
2. Takes a snapshot at `~/services/hive/<your-instance>.pre-0.2-bak` for rollback.
3. Relocates engine files into `.hive/`, sorts loose agent-written files into `agents/<id>/reports/archive-pre-0.2/` or `data/archive-pre-0.2/`.
4. Installs `@keepur/hive@0.2.0` globally (if not already).
5. Populates `.hive/` with the 0.2.0 engine bundle.
6. Rewrites `hive.yaml` `codeTask.pluginDirs` paths.
7. Regenerates your LaunchAgent plist(s) to point at the new engine.
8. Restarts the service and health-checks within 30 seconds.

Typical runtime: ~5 minutes per instance (most of that is disk I/O for the snapshot).

## Preview first (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/keepur/hive-docs/main/install/migrate-0.2.sh \
  | bash -s -- --dry-run ~/services/hive/<your-instance>
```

Dry-run mode runs the preflight and prints the full classification table for every loose file — no mutations. Review the table, then re-run without `--dry-run` for the real migration.

## If something goes wrong

The migration auto-rolls-back on health-check failure:

- Failed engine → deleted.
- Snapshot at `<instance>.pre-0.2-bak/` → moved back into place.
- LaunchAgent → re-bootstrapped against the restored snapshot.

Slack gets a `"Migration to 0.2.0 FAILED and was rolled back"` notification (via the same `DEVOPS_CHANNEL_ID` the deploy script uses).

If the auto-rollback fails (rare — usually a launchctl permissions issue), restore manually:

```bash
launchctl bootout gui/$(id -u)/com.hive.<label>  # stop current
rm -rf ~/services/hive/<your-instance>
mv ~/services/hive/<your-instance>.pre-0.2-bak ~/services/hive/<your-instance>
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hive.<label>.plist
```

Then pin back to 0.1.10 in your `instances.conf` (add `|v0.1.10` as the 7th column — see the [deployment docs](./deployment.md) for the pinning format).

## After a successful migration

- Your instance directory now has: `.hive/`, `.hive-state/`, `.env`, `hive.yaml`, `beekeeper.yaml`, `.hive-generated.json`, `logs/`, `service/`, `agents/`, `workflow/`, `data/`, `skills/`, `plugins/` (if any instance-authored).
- The engine is at `.hive/pkg/server.min.js`; your LaunchAgent's `ProgramArguments` points here.
- `hive update` now upgrades by wiping `.hive/` and extracting a new npm tarball (see [deployment docs](./deployment.md)).
- The snapshot at `<instance>.pre-0.2-bak/` stays on disk until you remove it. Wait 24+ hours for stability, then:
  ```bash
  rm -rf ~/services/hive/<your-instance>.pre-0.2-bak
  ```

## What happens to my loose files?

The classifier parks them under `agents/<id>/reports/archive-pre-0.2/` (when the agent is obvious from the filename prefix like `milo-standup-*`) or `data/archive-pre-0.2/` (for social scrapes, permit data, ad-hoc scripts). **Nothing is deleted** except `.playwright-mcp/` (21MB of browser console logs with no long-term value; the script flags this in the dry-run output).

Unsorted files land in `data/archive-pre-0.2/unsorted/`. Review and move them wherever makes sense after the migration.
