# Managing your hive

Day-two reference for running your hive after `hive init`. Every command below maps to a real `hive` CLI verb.

## Plugins

Plugins ship MCP servers and agent seeds. Each plugin is a separately-published npm package. Manage them with `hive plugin`.

### List installed plugins

```
$ hive plugin list
Installed plugins:

  @keepur/hive-plugin-google  v0.1.0  (hiveApi ^1.0.0)
  @keepur/hive-plugin-linear  v0.1.0  (hiveApi ^1.0.0)
  @keepur/hive-plugin-github  v0.1.0  (hiveApi ^1.0.0)
```

### Install a plugin

```
hive plugin add @keepur/hive-plugin-google
hive plugin add @keepur/hive-plugin-linear
hive plugin add @keepur/hive-plugin-github
```

The three currently published plugins:

- `@keepur/hive-plugin-google` — Gmail, Calendar, Drive. <https://www.npmjs.com/package/@keepur/hive-plugin-google>
- `@keepur/hive-plugin-linear` — Linear issue tracking. <https://www.npmjs.com/package/@keepur/hive-plugin-linear>
- `@keepur/hive-plugin-github` — GitHub Issues and PR tooling. <https://www.npmjs.com/package/@keepur/hive-plugin-github>

Each plugin reads its credentials from your instance's `.env` file (`~/services/hive/<your-instance>/.env`). Required keys are documented in each plugin's npm README. (The Honeypot + Keychain credential model is on the roadmap; until it ships, treat `.env` as the credential store and protect it accordingly.)

### Remove a plugin

```
hive plugin remove @keepur/hive-plugin-linear
```

This removes the entry from `hive.yaml` and uninstalls the npm package. **No agent data is deleted** — sessions, memory, and history stay in MongoDB. Re-adding the plugin restores tool access without losing state.

## Skills

Skills are reusable workflow patterns (prompts + steps) that any agent can invoke. They are not MCP servers — they are markdown packs pulled from a registry. The default registry is `keepur/hive-skills` and currently publishes:

- `morning-briefing` — daily standup digest
- `build-agent` — guided new-agent creation
- `quality-gate` — pre-PR checks bundle
- `create-tests` — test scaffolding for recent diffs

### Manage skills

```
$ hive skill list
Installed skills:

  morning-briefing           keepur/hive-skills   registry         -
  quality-gate               keepur/hive-skills   registry         -

$ hive skill add build-agent
Installed keepur/hive-skills/build-agent

$ hive skill remove morning-briefing
removed morning-briefing
```

Additional registries can be added with `hive registry`.

## Cross-agent coordination

When configuring an agent, three different fields wire three different cross-agent patterns. Pick the one whose semantics match what the agent actually needs:

- **`delegateServers`** — in-session sub-agent. Synchronous, ephemeral, returns into the caller's turn. Use when the agent needs a focused tool call done right now to finish the current turn.
- **Team MCP (auto-injected)** — direct messaging. 1-to-1, fire-and-forget by default; recipient handles the message in their own session and time-axis. Use when handing off a task whose owner is someone else. Available to every agent without configuration — the engine wires `team` as a core server unconditionally.
- **`coreServers: ["event-bus"]`** — pub/sub broadcast. 1-to-many; subscribers express interest by event name and react via their own work items. Use when announcing something that may concern multiple agents.

For the architectural distinctions and the engine-side wiring, see [architecture.md → Coordination primitives](architecture.md#coordination-primitives).

## Health checks

`hive doctor` verifies prerequisites (Node version, MongoDB reachable, required CLIs on PATH), config files (`hive.yaml`, `.env` keys present), agent definitions (loadable from MongoDB), and service state (launchd job loaded, process running, port bindings). It also prints a **Datastore identity** section (KPR-296): the connected mongod's server fingerprint (host, pid, uptime, version, dbPath), an independent verification of the DB identity sentinel, the engine's identity-monitor and roster-guard telemetry, and a live-vs-last-good roster count. Hard identity failures — sentinel mismatch, roster guard degraded, engine refusing writes — make the doctor **exit 1**, so CI or cron wrappers around `hive doctor` will see identity incidents as failures (as they already do for any failed required check — Node version, MongoDB reachable, service running). The telemetry sections below it (prompt cache, spawn coordinator, memory lifecycle) are informational and never affect the exit code.

```
hive doctor              # pass/fail per check
hive doctor --verbose    # adds fix hints for any failure
```

For specific failure modes and remediation, see [troubleshooting.md](troubleshooting.md).

## Updates

```
hive update
```

Stops the service, fetches the new `@keepur/hive` engine tarball into `<instance>/.hive.next/`, atomically swaps it with `<instance>/.hive/`, and restarts. Auto-rolls-back from `<instance>/.hive.prev/` if the health check fails. Run when the CLI prompts you, or weekly as routine maintenance.

To roll back the engine to the previously-installed version (without a full migration):

```
hive rollback
```

This restores `<instance>/.hive.prev/` over `<instance>/.hive/` and restarts. Available until the next `hive update` cycles the `.prev/` snapshot out.

### Migrating from 0.1.x

If you're still on 0.1.x, `hive update` is **not** the right command — the 0.1.x → 0.2.0 cutover is a one-shot layout migration, not a version bump. See [migrating-to-0.2.md](./migrating-to-0.2.md).

## Service control

- `hive start --daemon` — load the launchd job and run hive in the background.
- `hive stop` — unload the launchd job and stop the process.
- `hive status` — report whether the job is loaded, the process is running, and the Slack socket is connected.

## Configuration files

Two files at your instance root (`~/services/hive/<your-instance>/`). The CLI manages most of this; the fields below are the ones you may edit. Both files survive `hive update` and `hive rollback` — only the engine in `<instance>/.hive/` gets swapped.

### `<instance>/hive.yaml`

- `instance.id` — unique ID for this hive (used for DB name, tmp dirs, launchd label). Set once at `hive init`; changing it later is a migration, not an edit.
- `agents.default` — agent ID that catches unrouted messages.
- `plugins` — **do not hand-edit.** Managed by `hive plugin add` / `hive plugin remove`.
- `skills.registries` — list of registries to pull skills from. The default `keepur/hive-skills` is added at init; add others with `hive registry`.

### Migration notes (KPR-220)

- `agentManager.perTurnSpawn.{sms,slack,ws,voice}` keys are **removed**. Per-turn spawn is the only execution path now (it was opt-in during the channel-by-channel rollout; KPR-220 retired the opt-in). The YAML loader silently ignores any leftover `perTurnSpawn` keys you may have in `hive.yaml`, but they have no effect — drop them when convenient.
- On an agent definition, `maxConcurrent` is **deprecated** in favor of `spawnBudget` (both control how many in-flight spawns the agent can have at once, across different threads). The engine reads `agent.spawnBudget` first, falls back to `agent.maxConcurrent`, then to the engine default (5). `hive doctor`'s "Spawn coordinator" section shows which fallback fired per agent so you can migrate definitions one at a time.
- Reflection (end-of-conversation memory writes) trigger changed from queue-drain to post-quiescence debounce — reflection fires 30s after the most recent non-reflection turn on a thread. Setting `memory.reflectionMinTurns: 0` now disables reflection entirely. If you previously relied on `reflectionMinTurns: 0` as "off", behavior is unchanged; if you previously relied on it as "fire every turn", that semantics is gone (it was a footgun under the new debounce model).

### `<instance>/.env`

Core secrets:

- `ANTHROPIC_API_KEY` — Anthropic API key for agent inference.
- `SLACK_APP_TOKEN` — Slack app-level token (`xapp-…`) for Socket Mode.
- `SLACK_BOT_TOKEN` — Slack bot token (`xoxb-…`) for Web API calls.

Per-plugin keys are added here when you install the plugin (e.g. `LINEAR_API_KEY`, `GITHUB_TOKEN`, Google OAuth client). See each plugin's npm README for the exact variable names.
