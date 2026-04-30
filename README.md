<p align="center">
  <img src="https://raw.githubusercontent.com/keepur/hive/main/assets/keepur-logo.svg" width="160" alt="Keepur" />
</p>

<h1 align="center">Hive</h1>

<p align="center">
  <strong>The team you wish you'd hired by now.</strong>
</p>

<p align="center">
  A team of named AI coworkers in your Slack. They watch the threads, hold the open loops, draft the follow-ups, and bring you the morning briefing.
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@keepur/hive"><img src="https://img.shields.io/npm/v/@keepur/hive?label=npm&style=flat" alt="npm version" /></a>
  <a href="https://github.com/keepur/hive/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-Apache%202.0-blue?style=flat" alt="License" /></a>
  <img src="https://img.shields.io/badge/status-public%20beta-orange?style=flat" alt="public beta" />
</p>

---

> **Public beta.** Hive is in active beta. The product is solid for daily use; if you hit something weird, email [beta@keepur.io](mailto:beta@keepur.io) and a real human will help directly.

## Get the team running

Install [beekeeper](https://github.com/keepur/beekeeper) — the operator CLI — and let it drive the install:

```
sudo npm i -g @keepur/beekeeper
beekeeper install
beekeeper hive setup
```

`beekeeper hive setup` fetches the latest hive release and opens a Claude Code session that walks you through it: dependencies (Node, MongoDB, Ollama, Qdrant), `hive init`, Slack pairing, and your first conversation. Budget about 20 minutes end-to-end. The Claude Code session can answer questions, tail logs, and debug in real time.

If you'd rather drive it yourself, `npm i -g @keepur/hive && hive init` still works — see [Getting started](docs/getting-started.md) for the manual walkthrough.

## What you actually get

- **Coworkers in Slack.** Named teammates with their own channels and DMs. They show up like real coworkers — the lightest cognitive load to add to your already-busy life.
- **They actually remember.** Each one keeps notes on customers, projects, and decisions. They don't ask the same question twice. They don't lose context between Monday and Friday.
- **They run on schedule.** Morning briefing? Done. Friday pipeline summary? Sent. End-of-day open-loop sweep? Already in your inbox. They turn *"I should remember to do this"* into *"it just shows up."*
- **They find what was said.** *"What did Corey decide about the Smith deal?"* — answered in seconds, not by you scrolling through a month of Slack threads.
- **You approve risky things.** Customer emails, deal commitments, irreversible changes — they draft, you approve. Read-first, approve-first. Always, by default.

## How it goes

| Step | What happens |
|---|---|
| **01 — Add them to Slack** | Your AI coworkers show up as named teammates with their own channels and DMs. Not a chatbot. Not a search box. Coworkers your team can talk to like coworkers. |
| **02 — Give them work** | Status. Open loops. Follow-up drafts. Weekly briefings. The small coordination work nobody on the human team has time for. |
| **03 — See where the magic stops** | You'll see the power before it's reliable. That gap — between flashy demo and dependable coworker — is what we tune for paying customers. |
| **04 — Make one workflow reliable** | When one specific thing is worth getting right — sales follow-up, customer onboarding, ops briefings — we sit with you and shape the agents until that loop runs without you watching. |

## Trust posture

- **See exactly what's running.** The engine is Apache-2.0. Your CTO, your engineer, or a security-conscious operator can read it. No black box, no phone home.
- **Your data, your machine — even from the AI.** API keys live in your Mac's keychain. The language model itself never sees them, your customer records, or your secrets — local services fetch credentials only at the moment of use, only by tools you control. No prompt-context exposure, no log retention, no *"we keep your data to improve the model."*
- **Slack, where work already happens.** Agents show up in your existing channels and DMs. No new app to log in to. No new inbox to learn.
- **Customer-facing things wait for you.** Outbound emails, deal commitments, anything that can't be undone — agents draft, then ask. Read-first, approve-first — by default, not by reminder.

## Upgrading from 0.1.x

Hive 0.2.0 shipped a new instance directory layout (engine in `<instance>/.hive/`; config, logs, agent data stay at the root). Existing 0.1.x installs need a one-shot migration:

```
curl -fsSL https://raw.githubusercontent.com/keepur/hive/main/install/migrate-0.2.sh \
  | bash -s -- ~/services/hive/<your-instance>
```

Dry-run first (`--dry-run` before the instance path) to preview the file classification. Full walkthrough: [Migrating to 0.2.0](docs/migrating-to-0.2.md). Downtime is ~5 minutes per instance; the script auto-rolls-back on health-check failure.

## Updating

```
npm i -g @keepur/hive@latest
hive update
```

The order matters. `hive update` is driven by the globally-installed CLI, and an older CLI sometimes can't drive a newer engine layout. Refreshing the CLI first sidesteps that.

If an update doesn't go cleanly, `hive doctor` will tell you what state the install is in, and `hive rollback` swaps back to the previous engine.

## Documentation

- [Getting started](docs/getting-started.md) — install + first conversation
- [Managing your hive](docs/managing-your-hive.md) — plugins, skills, day-two ops
- [Architecture](docs/architecture.md) — what's inside the engine
- [Migrating to 0.2.0](docs/migrating-to-0.2.md) — for existing 0.1.x installs
- [Release notes — 0.2.0](docs/release-notes-0.2.0.md) — what's new, what broke
- [Troubleshooting](docs/troubleshooting.md) — when things break

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
hive rollback              # Roll back to previous engine
hive plugin add <pkg>      # Install a plugin
hive plugin list           # List installed plugins
hive plugin remove <name>  # Remove a plugin
hive skill add <name>      # Install a skill
hive skill list            # List installed skills
hive skill upgrade         # Upgrade installed skills
hive skill search <query>  # Search registries for a skill
hive skill remove <name>   # Remove a skill
hive registry add          # Add a skill registry
hive registry list         # List configured registries
hive registry remove       # Remove a registry
hive credentials list      # Show third-party API keys (curated)
hive credentials add <KEY> # Set or rotate a credential (Keychain-backed)
hive credentials remove <KEY>  # Delete a credential
```

## What we charge for

The shaping. The curation. The hands-on work to take generic agents and turn them into a reliable operation for *your* specific business. Plus certified plugin bundles, ongoing platform updates, and the support a small team needs when something feels off.

The principle: **the engine is open; you pay for the curation flow.** Run hive yourself for free, forever — Apache-2.0, no DRM, no phone home. Pay us when you want one workflow to become rock-solid faster than you'd shape it alone.

Beta cohorts get the curation work free while we learn — [ask for an invite](mailto:beta@keepur.io?subject=Keepur%20beta%20invitation%20code).

## License

Apache-2.0. See [LICENSE](LICENSE).

For commercial support, certified plugin bundles, or curation engagements, email [beta@keepur.io](mailto:beta@keepur.io).
