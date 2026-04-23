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

## Health checks

`hive doctor` verifies prerequisites (Node version, MongoDB reachable, required CLIs on PATH), config files (`hive.yaml`, `.env` keys present), agent definitions (loadable from MongoDB), and service state (launchd job loaded, process running, port bindings).

```
hive doctor              # pass/fail per check
hive doctor --verbose    # adds fix hints for any failure
```

For specific failure modes and remediation, see [troubleshooting.md](troubleshooting.md).

## Updates

```
hive update
```

Stops the service, updates the global `@keepur/hive` npm package, and restarts. Run when the CLI prompts you, or weekly as routine maintenance.

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

### `<instance>/.env`

Core secrets:

- `ANTHROPIC_API_KEY` — Anthropic API key for agent inference.
- `SLACK_APP_TOKEN` — Slack app-level token (`xapp-…`) for Socket Mode.
- `SLACK_BOT_TOKEN` — Slack bot token (`xoxb-…`) for Web API calls.

Per-plugin keys are added here when you install the plugin (e.g. `LINEAR_API_KEY`, `GITHUB_TOKEN`, Google OAuth client). See each plugin's npm README for the exact variable names.
