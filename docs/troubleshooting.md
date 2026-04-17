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
8. [Where to get help](#8-where-to-get-help)

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
3. Update `~/.hive/.env`:
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
2. Paste into `~/.hive/.env`:
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
tail -f ~/.hive/logs/hive.log
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

**Fix:** the Google plugin depends on the `gog` CLI, which ships separately. Install it per its own README, then ensure its install location is on the PATH the hive LaunchAgent sees (`/opt/homebrew/bin` is included by default; custom locations need the LaunchAgent plist updated). Restart:

```bash
hive stop
hive start --daemon
hive doctor
```

---

### 8. Where to get help

If `hive doctor` passes but something is still wrong — or a check fails in a way the sections above don't cover:

- **Trust-gate cohort (you got an onboarding email from May):** text May at the cell number in that email. Include the full output of `hive doctor --verbose` and the last ~50 lines of `~/.hive/logs/hive.log`.
- **Everyone else:** file an issue at <https://github.com/keepur/hive/issues> with the same two artifacts attached.
