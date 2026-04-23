# Deployment

**Target audience:** operators managing a Hive instance. Customers running a single instance via `hive update` only need the last section.

## Deploy flow

Hive deploys are **wipe-and-replace of `.hive/`**. No git pulls happen against the instance dir; the instance dir is not a git clone.

One deploy run (`deploy.sh`) does:

1. Pull latest in `$BUILD_DIR` (the actual git clone), run `npm install`, `npm run check`, `npm run build`, `npm run bundle`.
2. For each instance in `instances.conf`:
   - Stop the LaunchAgent.
   - Fetch the target tag's engine into `<instance>/.hive.next/` (primary: `npm pack @keepur/hive@<tag>`; fallback: rsync from `$BUILD_DIR/pkg/`).
   - `npm install --omit=dev` inside `.hive.next/` so the bundle's runtime externals (14 packages: native modules, large SDKs, asset loaders) resolve from `.hive/node_modules/`.
   - Swap: old `.hive.prev/` dropped, live `.hive/` → `.hive.prev/`, new `.hive.next/` → `.hive/`.
   - Restart the LaunchAgent.
   - Health check (30s for `"Hive is running"` in the log).
   - On health failure: auto-rollback (swap `.hive ↔ .hive.prev`), restart, notify Slack.

Exactly one `.hive/` (live) and at most one `.hive.prev/` (one step back) are retained. Deeper history is npm's job.

## Per-instance version pinning

`instances.conf` has an `ENGINE_TAG` column (7th pipe-separated field). Examples:

```
dodi|hive.yaml|-|com.hive.agent|logs|3100 3200|v0.2.0
keepur|hive-keepur.yaml|-|com.hive.keepur.agent|logs-keepur|3300 3303|v0.1.10
```

Each instance upgrades independently. `deploy-check.sh` polls `npm view` and triggers deploys only for instances whose installed version differs from their pinned tag.

- Omit the column to default to `latest` (autoupgrade on every publish).
- Accepts `v0.2.0` or `0.2.0` — leading `v` is stripped before npm calls.
- **Constraint until Phase 5:** instances that share a `DEPLOY_DIR` (today: `dodi` and `personal` share `~/services/hive`) share a single `.hive/` and MUST pin the same `ENGINE_TAG`. `deploy.sh` fails fast with `exit 2` if it sees diverging pins under one root. Once an instance is migrated to its own `<DEPLOY_DIR>/<id>/` dir, its pin can diverge freely.

## Operator commands

```bash
# Deploy whatever's pinned (runs from deploy.sh directly, for full orchestration).
./service/deploy.sh

# Deploy a specific instance to a specific tag.
./service/deploy.sh --instance=dodi --tag=v0.2.1

# Dry-run — shows what would happen, no side effects.
./service/deploy.sh --dry-run

# Roll back a specific instance to the previous engine.
./service/deploy.sh --rollback --instance=dodi
```

## Customer commands

From a customer's shell, inside any Hive install:

```bash
# Update to latest published @keepur/hive.
hive update

# Update to a specific version.
hive update --tag=0.2.1

# Roll back to the previous engine version.
hive rollback
```

Both commands shell out to `deploy.sh` inside the instance's own `.hive/service/`. No separate update paths; `hive update` is `deploy.sh --tag=latest --instance=<current>` with a typed CLI wrapper.

## Rollback details

- `rollback` requires `.hive.prev/` to exist — it's the previous engine preserved from the last successful deploy.
- The failed engine is moved to `.hive.broken/` for operator inspection; the next successful deploy rotates it out.
- `.hive.prev/` is consumed by the rollback — a second consecutive rollback requires another deploy first (to re-establish a `.hive.prev/`).

## What's in `<instance>/` after a deploy

```
<instance>/
  .hive/                   # live engine — wipe-and-replace each deploy
    pkg/server.min.js      # entry point
    seeds/ templates/      # engine assets
    scripts/honeypot
    service/deploy.sh      # this script — shipped inside the engine
    package.json           # version stamp
  .hive.prev/              # previous engine (rollback target); may be absent on fresh installs
  .hive.broken/            # failed engine from last rollback (if any)
  .env                     # secrets, survives upgrades
  hive.yaml                # instance config, survives upgrades
  logs/                    # observability, survives upgrades
  agents/, workflow/, data/, skills/, plugins/   # instance-authored, survives upgrades
```

`.hive/` is the **upgrade boundary**. Everything else is yours.
