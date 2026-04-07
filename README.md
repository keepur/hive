# Hive

A multi-agent AI framework that runs your business operations through Slack. Hive deploys a team of Claude-powered agents — each with its own role, memory, and tools — that collaborate to handle real work: customer emails, CRM updates, task management, scheduling, SMS, and more.

## Why Hive

Most AI agent frameworks give you a chatbot. Hive gives you a team.

### The problem with single-agent tools

Tools like OpenClaw, CrewAI, and AutoGen are great for demos — chain a few LLM calls together, get a result. But they fall apart when you try to run actual business operations:

- **No identity** — every request starts from zero. There's no persistent memory, no role specialization, no sense of "who" is handling what.
- **No channels** — they live in a notebook or CLI. Your team can't interact with them naturally.
- **No tools** — connecting to real systems (CRM, email, calendars, project management) requires custom glue code for every integration.
- **No cost control** — every query hits the most expensive model, even simple ones.

### What Hive does differently

| Capability | Hive | Typical agent framework |
|-----------|------|------------------------|
| **Agent identity** | Each agent has a name, personality, role, persistent memory, and dedicated Slack channel | Anonymous function chains |
| **Channel-native** | Lives in Slack — your team @mentions agents like coworkers. Also supports SMS, WebSocket (mobile), and email. | CLI or API-only |
| **Tool ecosystem** | 20+ MCP servers out of the box — Gmail, Calendar, CRM, GitHub, task management, vector search, SMS, email, browser automation | BYO everything |
| **Smart routing** | Triage classifies messages, model router picks Haiku/Sonnet/Opus per-turn based on complexity. Simple questions cost pennies. | One model for everything |
| **Persistent memory** | MongoDB-backed per-agent memory with hot/warm/cold tiers, version history, and semantic recall | Stateless or basic RAG |
| **Multi-agent coordination** | Flat org with channel-based routing — agents delegate to specialists, no central bottleneck | Sequential chains or rigid DAGs |
| **Production-ready** | LaunchAgent service, hot-reload, concurrency limits, deduplication, retry queues, structured logging | "Just run the script" |
| **Plugin system** | Drop in business-specific integrations (CRM, catalog, manufacturing) without touching core | Monolithic |

### Architecture at a glance

```
Message (Slack / SMS / WebSocket / Scheduler)
  → Channel Adapter
  → Dispatcher (routing, dedup, thread continuity)
  → Triage (fast Haiku: done or continue?)
  → Model Router (Haiku/Sonnet/Opus based on complexity)
  → Agent Runner (Claude session + per-agent MCP servers + memory)
  → Response → Channel Adapter → delivery
```

### Who it's for

Hive is built for small-to-medium businesses that want AI teammates, not AI toys. If you have a Slack workspace and real operational workflows (sales, support, marketing, ops), Hive turns Claude into a team that works alongside yours.

**Requirements**: Mac (tested on Mac Mini M-series), MongoDB, Node.js 22+, a Slack workspace, and an Anthropic API key or Claude Max subscription.

---

## Quick Start

```bash
# 1. Install prerequisites
npm run setup:prereqs

# 2. Install dependencies and run the setup wizard
npm install
npm run setup

# 3. Start Hive
npm start
```

The setup wizard walks you through everything: Slack app creation, API keys, business context, and service installation. It seeds a **chief-of-staff** agent to start — additional agents are created through it as your needs evolve.

## Prerequisites

Mac (tested on Mac Mini M-series) with:

- **Node.js 22+** — JavaScript runtime
- **MongoDB** — database for agent memory, definitions, contacts, and state
- **Git** — version control

The prereqs script installs all of these via Homebrew:

```bash
npm run setup:prereqs
```

If you already have them, the script skips what's installed.

## What You'll Need

Before running `npm run setup`, have these ready:

### Required

- **Slack workspace** you can install apps into
- **Anthropic API key** or **Claude Max subscription** — if using Max, the SDK authenticates via OAuth automatically (no API key needed)

### Optional (enable as you grow)

- **Resend API key** — outbound email per agent
- **Quo (OpenPhone) API key** — SMS integration
- **Google account(s)** — Gmail and Calendar access (via `gog` CLI)
- **HubSpot API key** — CRM read/write
- **GitHub repo** — issue tracking integration
- **Brave Search API key** — web search for agents
- **Gemini API key** — vision/OCR for file attachments
- **ClickUp / Linear API key** — project management

## Setup Guide

### 1. Create Your Slack App

The setup wizard displays a complete app manifest. Here's the short version:

1. Go to https://api.slack.com/apps
2. **Create New App** > **From a manifest**
3. Select your workspace, choose **YAML** format
4. Paste the manifest the wizard shows you
5. **Create**, then **Install App** > **Install to workspace**

You'll need two tokens:

| Token | Where to find it | Looks like |
|-------|-----------------|------------|
| App-Level Token | Basic Information > App-Level Tokens > Generate (add `connections:write` scope) | `xapp-...` |
| Bot Token | OAuth & Permissions > Bot User OAuth Token | `xoxb-...` |

**Optional:** For Slack search, grab a User Token (`xoxp-...`) from the same OAuth page.

### 2. Anthropic API Key (or Claude Max)

**API key**: Get one from https://console.anthropic.com/settings/keys (starts with `sk-ant-`).

**Claude Max**: Leave `ANTHROPIC_API_KEY` blank in `.env`. The Claude Agent SDK authenticates via your logged-in CLI session.

### 3. SMS via Quo (Optional)

1. Get your API key from Quo workspace settings > API tab
2. Get your Phone Number ID(s) — they look like `PNxxxxx`
3. The wizard will ask you to configure named phone lines

### 4. Google Gmail/Calendar (Optional)

Install the [`gog`](https://github.com/jcfisher/gog) CLI:

```bash
brew install gog
```

Add accounts:

```bash
gog auth add you@gmail.com
# Opens a browser for OAuth — authenticate once, tokens stored locally

# Multiple accounts:
gog auth add work@company.com
gog auth add sales@company.com
```

Verify:

```bash
gog gmail search "is:unread" -a you@gmail.com
gog cal events --today -a you@gmail.com
```

### 5. Email via Resend (Optional)

Get an API key from https://resend.com. Configure your sending domain and per-agent from addresses in `hive.yaml`.

## Configuration

Hive uses two config files (both generated by the setup wizard, both gitignored):

### `.env` — secrets

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
# ANTHROPIC_API_KEY=sk-ant-...  # Leave blank if using Claude Max
# Plus optional: QUO_API_KEY, RESEND_API_KEY, HUBSPOT_API_KEY, etc.
```

### `hive.yaml` — instance config

```yaml
business:
  name: "Your Business Name"
  description: "what your business does"
  location: "City, State"
  owner:
    name: "Your Name"
    role: "CEO"

# plugins:
#   - your-plugin  # Business-specific integrations
```

See `hive.yaml.example` for all options including SMS lines, email, and Google Workspace.

## Agents

Hive starts with a single **chief-of-staff** agent. More agents are created as your needs evolve — no need to configure them all upfront.

Agent definitions live in **MongoDB** (not the filesystem). Each agent definition contains:

| Field | Purpose |
|-------|---------|
| `model` | Model ceiling (haiku, sonnet, opus) |
| `channels` | Which Slack channels this agent responds in |
| `servers` | Which MCP tool servers this agent can use |
| `soul` | Personality, values, voice |
| `systemPrompt` | Role definition, guidelines, tool instructions |
| `schedule` | Cron expressions for recurring tasks |

Manage agents via the admin MCP tools or the REST API. Changes take effect on hot-reload (SIGUSR1) — no restart needed.

## Memory

Agent memory is stored in **MongoDB** with version history and semantic recall:

| Collection | Purpose |
|-----------|---------|
| `memory` | Current memory records (hot/warm/cold tiers) |
| `memory_versions` | Full version history of every change |
| `agent_definitions` | Agent configs, prompts, personality |
| `agent_sessions` | Active session state |

Agents read and write memory through the memory MCP server. Memory is structured with tiered lifecycle management — frequently accessed records stay hot (injected into prompts), less-used records drop to warm (semantic recall on demand), and stale records are summarized and archived.

## MCP Tool Servers

Each agent gets a tailored set of MCP servers based on its role. Available servers:

| Server | What it does |
|--------|-------------|
| **memory** | Read/write/recall agent memory (MongoDB) |
| **slack** | Slack API (official HTTP MCP server) |
| **google** | Gmail + Calendar via `gog` CLI |
| **contacts** | Contact lookups |
| **github-issues** | GitHub issue tracking via `gh` CLI |
| **crm-search** | Semantic search over CRM data (Qdrant) |
| **resend** | Outbound email |
| **quo** | SMS via OpenPhone |
| **schedule** | Self-service schedule management |
| **callback** | Timer-based delayed responses |
| **background** | Spawn long-running tasks |
| **admin** | Agent CRUD + version history |
| **keychain** | macOS Keychain read-only |
| **brave-search** | Web search |
| **recall** | Meeting participation via Recall.ai |
| **code-task** | Delegate coding to Claude Code CLI |

Plugins can add more (e.g., HubSpot CRM, product catalog, permit management).

## Running Hive

```bash
# Production (compiled)
npm start

# Development (live reload)
npm run dev

# View logs
tail -f logs/hive.log
```

### Run as a LaunchAgent (starts on login)

The setup wizard offers to install as a LaunchAgent. Manually:

```bash
bash service/install.sh
```

Manage the service:

```bash
# Restart
launchctl kickstart -k gui/$(id -u)/com.hive.agent

# Stop
launchctl bootout gui/$(id -u)/com.hive.agent

# Start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.hive.agent.plist
```

## Plugins

Business-specific integrations live in `plugins/<name>/`. A plugin can include:

- **MCP servers** — domain-specific tools (CRM, catalog, manufacturing)
- **Agent seeds** — starter agent definitions imported via `npm run setup:seeds`

Enable plugins in `hive.yaml`:

```yaml
plugins:
  - your-plugin
```

## Dev vs Deploy

| | Dev | Deploy |
|---|-----|--------|
| **Path** | `~/github/hive` | `~/services/hive` |
| **Purpose** | Edit, test, commit, push | Compiled JS, launchd runs here |
| **Deploy** | — | `deploy.sh` pulls, builds, syncs, restarts |

Editing source in dev does **not** affect the running service.

## Updating

```bash
npm run update
```

Pulls latest code, installs dependencies, and rebuilds. Your `hive.yaml`, `.env`, and agent definitions (in MongoDB) are preserved.

## npm Scripts

| Script | What it does |
|--------|-------------|
| `npm start` | Start Hive (production, compiled) |
| `npm run dev` | Start Hive (development, live reload) |
| `npm run build` | Compile TypeScript (core + plugins) |
| `npm run setup` | Interactive setup wizard |
| `npm run setup:prereqs` | Install Homebrew, Node.js, MongoDB, Git |
| `npm run setup:seeds` | Import plugin agent seeds → MongoDB |
| `npm run setup:constitution` | Render shared constitution → MongoDB |
| `npm run setup:plist` | Regenerate the launchd plist |
| `npm run update` | Pull latest, install deps, rebuild |
| `npm run check` | All checks (typecheck + lint + format + test) |

## Troubleshooting

| Problem | Fix |
|---------|-----|
| Agent not responding | Check `logs/hive.log` for errors. Verify Slack tokens in `.env`. |
| MCP server changes not taking effect | Run `npm run build` AND restart Hive — MCP servers run from compiled `dist/`. |
| Agent config changes not taking effect | Send SIGUSR1 to hot-reload: `kill -USR1 $(pgrep -f "node dist/index")` |
| Slack connection drops | Check `SLACK_APP_TOKEN` has `connections:write` scope. Socket Mode must be enabled. |
| MongoDB connection refused | Ensure MongoDB is running: `brew services start mongodb-community` |

## License

Private — access by invitation only.
