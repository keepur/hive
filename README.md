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
  <a href="https://github.com/keepur/hive/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-FSL--1.1--ALv2-blue?style=flat" alt="License" /></a>
  <img src="https://img.shields.io/badge/status-public%20beta-orange?style=flat" alt="public beta" />
</p>

---

## Install

```
sudo npm i -g @keepur/beekeeper
beekeeper install
beekeeper hive setup
```

That's it. `beekeeper hive setup` opens a Claude Code session that walks you through installing dependencies (Node, MongoDB, Ollama, Qdrant), running `hive init`, pairing Slack, and your first conversation. Budget about 20 minutes. The session can answer questions, tail logs, and debug in real time.

If something breaks during install, ask the session — it has the source repo (this one) in scope and knows the troubleshooting docs by heart.

## What you get

- **Coworkers in Slack.** Named teammates with their own channels and DMs.
- **They remember.** Notes on customers, projects, decisions — they don't ask the same question twice.
- **They run on schedule.** Morning briefings, weekly summaries, end-of-day open-loop sweeps.
- **They find what was said.** *"What did Corey decide about the Smith deal?"* — answered in seconds.
- **You approve risky things.** Outbound emails, deal commitments — they draft, you approve. Read-first, approve-first.

## Trust posture

- **Source-available.** Engine is licensed under FSL-1.1-ALv2 — read the source before you run it; use it freely for your business; build derivatives. The only restriction is offering a competing product. Each version converts to Apache-2.0 two years after release.
- **Your data, your machine.** API keys live in your Mac's keychain. The language model never sees them, your customer records, or your secrets. No phone home.
- **Customer-facing things wait for you.** Outbound emails, deal commitments — by default, drafts that need your approval.
- **Visibility when you want it.** Run `hive doctor` for a snapshot of engine health (MongoDB connectivity, agent registry, prompt-cache telemetry).

## What we charge for

The shaping. The curation. Taking generic agents and turning them into a reliable operation for *your* business. The engine is open and free; you pay when you want one workflow to become rock-solid faster than you'd shape it alone.

Beta cohorts get the curation work free while we learn — [ask for an invite](mailto:beta@keepur.io?subject=Keepur%20beta%20invitation%20code).

## Docs

For deeper reading or when something breaks:

- [Architecture](docs/architecture.md) — what's inside the engine.
- [Managing your hive](docs/managing-your-hive.md) — plugins, skills, day-two ops.
- [Troubleshooting](docs/troubleshooting.md) — when things break.

## License

Functional Source License, Version 1.1, ALv2 Future License (FSL-1.1-ALv2). See [LICENSE](LICENSE).

Use it for your business, internally or for your customers — that's a Permitted Purpose. The license restricts only Competing Use: building a product or service that substitutes for Hive itself. Each version converts to Apache-2.0 two years after release.

Earlier versions (0.1.0 – 0.6.0) were released under Apache-2.0 and remain available under that license; see [NOTICE](NOTICE) for history.

For commercial licensing outside the Permitted Purpose, support, certified plugin bundles, or curation engagements, email [beta@keepur.io](mailto:beta@keepur.io).
