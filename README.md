# Hive

> A team of Claude agents that runs your business in Slack.

Most AI tools give you a chatbot. Hive gives you a team. Each agent has a name, a role, persistent memory, and its own Slack channel. Your team @mentions them like coworkers — they handle customer emails, CRM updates, scheduling, SMS, research, and the long tail of operational work that nobody on your real team has time for.

It runs on a Mac you already own. One Anthropic key, one Slack workspace, one install command.

## Install

```
# Fresh Mac
curl -fsSL https://raw.githubusercontent.com/keepur/hive/main/install/bootstrap.sh | bash

# Already have Node 22
npm i -g @keepur/hive && hive init
```

The bootstrap installs Homebrew and Node 22, then drops you into the `hive init` wizard which handles the rest (MongoDB, Ollama, Qdrant). Budget about 20 minutes end-to-end.

## Documentation

- [Getting started](docs/getting-started.md) — install + first conversation
- [Managing your hive](docs/managing-your-hive.md) — plugins, skills, day-two ops
- [Troubleshooting](docs/troubleshooting.md) — when things break

## What you get

- **A real team, not a chatbot.** Each agent has identity, voice, and a dedicated Slack channel. Mentions, threads, and DMs all work the way your team already uses Slack.
- **Persistent memory.** Agents remember what you've told them, what they've done, and who they've talked to — backed by MongoDB with semantic recall and version history.
- **Plugin ecosystem.** Drop in integrations for Gmail, Calendar, HubSpot, GitHub, Linear, ClickUp, SMS, email, and more. Plugins ship MCP servers and starter agents together.
- **Smart cost control.** A per-turn classifier picks Haiku, Sonnet, or Opus based on what the message actually needs. Simple replies cost pennies.
- **Mac-native deployment.** Runs as a launchd service on a Mac Mini you already have. No cloud bill, no container orchestration, no egress fees on your business data.

## Requirements

- A Mac (Apple Silicon recommended)
- An Anthropic API key — [console.anthropic.com](https://console.anthropic.com/)
- Admin access to a Slack workspace

## Quick reference

```
hive init                  # Interactive setup wizard
hive start --daemon        # Start as background service
hive stop                  # Stop the service
hive status                # Service status
hive doctor [--verbose]    # Health check (with fix hints)
hive update                # Update to latest version
hive plugin add <pkg>      # Install a plugin
hive plugin list           # List installed plugins
hive plugin remove <name>  # Remove a plugin
hive skill add <name>      # Install a skill
hive skill list            # List installed skills
hive skill remove <name>   # Remove a skill
```

## License

Hive is closed-source commercial software, distributed in public beta under the [Hive Preview License](LICENSE). Evaluation is permitted; production use requires an invited early-cohort license or a commercial agreement.

For access or commercial licensing, contact beta@keepur.io.
