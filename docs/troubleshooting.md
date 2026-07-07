# Troubleshooting

Run `hive doctor --verbose` first — it diagnoses 90% of problems.

`hive doctor` runs a battery of checks and prints each as `✓` (pass) or `✗` (fail). The sections below are indexed by the failing check name (or symptom, for failures `doctor` can't see directly). For each: what you'll see, what it means, what to do.

## Failure modes

1. [MongoDB not running](#1-mongodb-not-running)
2. [Slack token rejected](#2-slack-token-rejected)
3. [`ANTHROPIC_API_KEY` missing or invalid](#3-anthropic_api_key-missing-or-invalid)
4. [LaunchAgent not loaded](#4-launchagent-not-loaded)
5. [Port conflict on init](#5-port-conflict-on-init)
6. [Plugin install fails `hiveApi` compat check](#6-plugin-install-fails-hiveapi-compat-check)
7. [`gog` CLI not on PATH after Google plugin install](#7-gog-cli-not-on-path-after-google-plugin-install)
8. [Datastore identity failures (`hive doctor` exits 1)](#8-datastore-identity-failures-hive-doctor-exits-1)
9. [Where to get help](#9-where-to-get-help)

---

### 1. MongoDB not running

**Symptom:** Chief of Staff doesn't respond. `hive doctor` shows:

```
✗ MongoDB reachable
```

(You may also see `✗ MongoDB (brew services)` if the service itself isn't started.)

**Fix:**

```bash
brew services start mongodb-community
hive doctor
```

If `brew services` reports MongoDB as already started but `MongoDB reachable` still fails, the daemon crashed — check `~/Library/LaunchAgents/homebrew.mxcl.mongodb-community.plist` and `tail -f /opt/homebrew/var/log/mongodb/mongo.log`.

---

### 2. Slack token rejected

**Symptom:** `hive doctor` shows:

```
✗ Slack auth.test
```

Agents don't see Slack messages and Slack delivery fails.

**Fix:** regenerate tokens and reinstall the app.

1. Go to <https://api.slack.com/apps> → your Hive app → **OAuth & Permissions** → reinstall to workspace.
2. Copy the new **Bot User OAuth Token** (`xoxb-...`) and **App-Level Token** (`xapp-...`).
3. Update your instance's `.env` (at `~/services/hive/<your-instance>/.env`):
   ```
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_APP_TOKEN=xapp-...
   ```
4. Restart:
   ```bash
   hive stop
   hive start --daemon
   hive doctor
   ```

---

### 3. `ANTHROPIC_API_KEY` missing or invalid

**Symptom:** Agent replies with an API error message, or messages go in and nothing comes out. `hive doctor` may pass `config loads (hive.yaml + required env)` if the key is present-but-invalid — the API call is what fails.

**Fix:**

1. Get a key at <https://console.anthropic.com/settings/keys>.
2. Paste into your instance's `.env` (at `~/services/hive/<your-instance>/.env`):
   ```
   ANTHROPIC_API_KEY=sk-ant-...
   ```
3. Restart:
   ```bash
   hive stop
   hive start --daemon
   ```

If `config loads (hive.yaml + required env)` still fails after editing `.env`, double-check the variable name and that there are no surrounding quotes.

---

### 4. LaunchAgent not loaded

**Symptom:** Nothing responds to messages. `hive status` reports the service is not running. `hive doctor` shows:

```
✗ LaunchAgent com.hive.agent running
```

**Fix:**

```bash
hive start --daemon
hive status
```

If `hive start --daemon` itself fails or the LaunchAgent flips back to not-running, tail the log to find the underlying error:

```bash
tail -f ~/services/hive/<your-instance>/logs/hive.log
```

The most common cause is one of the failure modes above (MongoDB down, missing API key, bad config) — fix that, then `hive start --daemon` again.

---

### 5. Port conflict on init

**Symptom:** `hive init` exits with `EADDRINUSE` or a port-scan failure. Another process is bound to a port the new instance wants.

**Fix:** another hive instance or local service is using the port. Either rerun `hive init` (it scans for the next free block of ports) or stop the conflicting service. To find what's holding a port:

```bash
lsof -nP -iTCP:<port> -sTCP:LISTEN
```

Kill the offender or pick a different port block, then rerun `hive init`.

---

### 6. Plugin install fails `hiveApi` compat check

**Symptom:** `hive plugin add <name>` exits with:

```
Plugin requires hiveApi <range> but this hive is <version>
```

The plugin declares a `hiveApi` semver range in its `plugin.yaml`, and your installed core falls outside it.

**Fix:**

```bash
hive update
hive plugin add <name>
```

If the plugin is ahead of core (its required range is newer than any released core), wait for the next core release. If core is ahead of the plugin (range too old), nudge the plugin author to bump the range — don't downgrade core.

---

### 7. `gog` CLI not on PATH after Google plugin install

**Symptom:** Google plugin loaded successfully, but Gmail or Calendar tools error with `gog: command not found` or `gog not found`. `hive doctor` shows:

```
✗ gog CLI
```

(This check is non-required — it only fires if a plugin needs it.)

**Fix:** the Google plugin depends on the `gog` CLI, which ships separately. Install it via Homebrew:

```bash
brew install gog
```

Ensure its install location is on the PATH the hive LaunchAgent sees (`/opt/homebrew/bin` is included by default; custom locations need the LaunchAgent plist updated). Then restart:

```bash
hive stop
hive start --daemon
hive doctor
```

---

### 8. Datastore identity failures (`hive doctor` exits 1)

The **Datastore identity** section (KPR-296) answers "is the mongod behind `config.mongo.uri` actually this instance's database?" It is the first and only *post-check* doctor section that can **fail the doctor (exit 1)** — the required prerequisite/config/agent/service checks above it already exit 1 on failure (see §§1–4); among the post-check telemetry sections, this is the only one that does. Three conditions fail; everything else warns or informs. Entries below are indexed by the failing line.

#### `✗ identity sentinel MISMATCH — expected <id>/<db>, observed <other>/<other-db>` (F1)

**Symptom:** exit code 1; the section's server fingerprint (host, pid, uptime, `dbPath`) may show a mongod you don't recognize.

**Meaning:** the DB the doctor connected to carries another instance's identity sentinel — you're pointed at the wrong DB, the wrong mongod is answering on the configured port (the Jul-4 impostor scenario), or you intentionally adopted another instance's data.

**Fix:** first verify *which* mongod answered using the fingerprint printed at the top of the section — cross-check with `brew services list` and `lsof -i :27017`. If the wrong mongod is answering, stop it and restore the right one; if the DB itself is wrong, restore the right DB. If the adoption is intentional (e.g. bringing another instance's backup under this instance id), set `HIVE_DB_SENTINEL_RESTAMP=1` for exactly one engine boot, then remove it — it re-stamps every boot it is set.

#### `✗ roster guard DEGRADED since <ts> — engine holding last-good roster` (F2)

**Symptom:** exit code 1; agents still respond (the engine is serving its last-good roster).

**Meaning:** an agent-definitions reload read **zero** documents after this process had previously loaded a non-empty roster (KPR-295 empty-roster guard). The engine blocked the wipe as a full no-op and is retrying every 30s. Usual causes: DB wiped, restored empty, or an impostor mongod answering.

**Fix:** restore or verify the DB (check the fingerprint/sentinel lines in the same section). Once agent definitions reappear the guard **auto-recovers within ~30s** — no restart, no operator ack. If the engine was restarted mid-episode and came up on an empty DB, send `SIGUSR1` after the restore to reload. If you genuinely mean to run with an empty roster: restart the engine — there is no bypass knob; a fresh process has no non-empty baseline and commits the empty set.

#### `✗ engine identity monitor: <state> — writes refused=…` (F3)

**Symptom:** exit code 1; the `db_identity_stats` heartbeat is fresh (≤120s) but reports a non-verified state (unknown states fail closed).

**Meaning:** the *running engine* has detected an identity problem and **is refusing DB writes right now** — this is the live counterpart of F1; the doctor is relaying the engine's own alarm.

**Fix:** read the engine logs (look for the `critical: true` marker) to see what the identity monitor observed, then resolve as F1 — verify the mongod, restore the right DB, or `HIVE_DB_SENTINEL_RESTAMP=1` if adoption is intentional. Writes resume automatically once the monitor re-verifies.

#### `⚠ identity sentinel absent but DB has hive data (<n> agent defs)` (W1 — warn, not fail)

**Meaning:** the DB has data but no sentinel — expected exactly once per pre-KPR-294 instance: the engine hasn't booted since the upgrade, and it stamps the sentinel on next boot. If the engine *has* booted since upgrading, you may be looking at a different DB than the engine is.

**Fix:** start (or restart) the engine, re-run `hive doctor`, confirm the line flips to `✓ identity sentinel matches`.

#### `⚠ connected mongod dbPath is a TEMP directory` (warn)

**Meaning:** the answering mongod's `dbPath` is under `/tmp` or `/var/folders` — the exact Jul-4 impostor signature (a scratch mongod squatting on the production port).

**Fix:** verify what's listening (`brew services list; lsof -i :27017`), kill the squatter, confirm the real mongod is bound, re-run the doctor.

Remaining warn tier, one line each:

- `⚠ roster: <n> docs but 0 active and not all disabled` — validation evicted every agent (engine/data version skew); check engine logs from the last reload.
- `⚠ roster divergence: DB has <n> agent defs, engine last committed <m>` — live count ≠ last committed roster (e.g. the engine restarted during a DB outage); send `SIGUSR1` after restore to reload.

#### Operator drill (safe — touches only a throwaway mongod)

Adapted from the KPR-296 implementation plan's E2E drill (`docs/epics/kpr-293/kpr-296-plan.md`, Testing Contract → E2E). Exercises F1, the temp-path warn, and W1 without touching the real DB:

1. **Happy path:** on a healthy instance with the engine running: `hive doctor; echo $?` → the Datastore identity section shows the server fingerprint and `✓` sentinel / `✓` engine monitor / `✓` roster lines; exit `0`.
2. **F1 + temp-path (impostor-shaped):** start a scratch mongod on a spare port with a throwaway data dir: `mongod --dbpath "$(mktemp -d)" --port 27099 &`. Stamp a *foreign* sentinel + one dummy agent def (`<dbName>` below must be your instance's **configured** DB name — `hive_<instance-id>` by default, or `MONGODB_DB` if set — otherwise the doctor sees an absent sentinel, not a MISMATCH):

   ```
   mongosh --port 27099 <dbName> --eval 'db.instance_identity.insertOne({_id:"identity_sentinel",schemaVersion:1,instanceId:"other",dbName:"hive_other",sentinelId:"drill",stampedAt:new Date(),stampedBy:{engineVersion:"drill",hostname:"drill",pid:1}}); db.agent_definitions.insertOne({_id:"dummy",isDefault:true})'
   ```

   Then from the instance dir: `MONGODB_URI=mongodb://localhost:27099 hive doctor; echo $?` → expect `✗ identity sentinel MISMATCH — expected …, observed other/hive_other` with the RESTAMP remediation, the `⚠ … TEMP directory …` warning (`mktemp` lands under `/var/folders` on macOS), exit `1`.
3. **W1 (upgrade window):** on the scratch mongod: `db.instance_identity.deleteOne({_id:"identity_sentinel"})`, re-run the doctor → expect `⚠ identity sentinel absent but DB has hive data (1 agent defs)`; the identity section itself does **not** fail (other sections may still fail on the scratch DB — read the section, not just `$?`).
4. **Teardown:** kill the scratch mongod; re-run step 1 against the real instance to confirm it is untouched (the drill wrote only to the throwaway `--dbpath`; the doctor itself writes nothing).

Drill safety properties preserved per spec Edge #3: scratch mongod on a spare port, throwaway `--dbpath`, teardown step confirming the real DB untouched — no step touches a live instance's DB.

---

### 9. Where to get help

If `hive doctor` passes but something is still wrong — or a check fails in a way the sections above don't cover:

- **Trust-gate cohort (you got an onboarding email from May):** text May at the cell number in that email. Include the full output of `hive doctor --verbose` and the last ~50 lines of `~/services/hive/<your-instance>/logs/hive.log`.
- **Everyone else:** file an issue at <https://github.com/keepur/hive/issues> with the same two artifacts attached.
