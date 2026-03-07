# Hive

Multi-agent AI orchestration framework for Slack. Hive runs a team of Claude-powered agents that respond to messages, manage tasks, send SMS, read email, and more — all from your Slack workspace.

## Quick Start

```bash
# 1. Install prerequisites (Homebrew, Node.js, MongoDB, Git)
npm run setup:prereqs

# 2. Run the interactive setup wizard
npm install
npm run setup

# 3. Start Hive
npm start
```

The setup wizard walks you through everything: Slack app creation, API keys, and service installation. It sets up the **chief-of-staff** agent first — additional agents are created through it as needed.

## Prerequisites

You need a Mac (tested on Mac Mini M-series) with:

- **Node.js 22+** — JavaScript runtime
- **MongoDB** — local database for memory, contacts, and state
- **Git** — version control

The prereqs script installs all of these via Homebrew:

```bash
npm run setup:prereqs
```

If you already have them, the script will skip what's installed.

## What You'll Need

Before running `npm run setup`, have these ready:

### Required

- **Slack workspace** you can install apps into
- **Anthropic API key** or **Claude Max subscription** — if using Max, the SDK authenticates via OAuth automatically (no API key needed)

### Optional

- **Quo (OpenPhone) API key** — for SMS integration
- **Google account(s)** — for Gmail and Calendar access (requires `gog` CLI)
- **Linear API key** — for project management integration

## Setup Guide

### 1. Slack App

The setup wizard will display a complete app manifest for you to paste into Slack. Here's the short version:

1. Go to https://api.slack.com/apps
2. Click **Create New App** > **From a manifest**
3. Select your workspace, choose **YAML** format
4. Paste the manifest the wizard shows you
5. Click **Create**, then go to **Install App** > **Install to workspace**

You'll need two tokens from your new app:

| Token | Where to find it | Looks like |
|-------|-----------------|------------|
| App-Level Token | Basic Information > App-Level Tokens > Generate (add `connections:write` scope) | `xapp-...` |
| Bot Token | OAuth & Permissions > Bot User OAuth Token | `xoxb-...` |

**Optional:** For Slack search capabilities, you'll also want a User Token (`xoxp-...`) from the same OAuth page.

### 2. Anthropic API Key (or Claude Max)

If using an API key, get it from https://console.anthropic.com/settings/keys. It starts with `sk-ant-`.

If using a **Claude Max subscription**, leave `ANTHROPIC_API_KEY` blank in `.env`. The Claude Agent SDK will authenticate via OAuth using your logged-in Claude CLI session.

### 3. SMS via Quo (Optional)

If you use OpenPhone/Quo for SMS:

1. Get your API key from Quo workspace settings > API tab
2. Get your Phone Number ID(s) — they look like `PNxxxxx`
3. The wizard will ask you to configure named phone lines

### 4. Google Gmail/Calendar (Optional)

Hive uses the [`gog`](https://github.com/jcfisher/gog) CLI for Google access.

#### Install gog

```bash
brew install gog
```

#### Single account

```bash
gog auth add you@gmail.com
```

This opens a browser for OAuth. Authenticate once, and gog stores the refresh token locally.

#### Multiple accounts

If you have several Google accounts (personal, work, sales, etc.), add each one:

```bash
gog auth add personal@gmail.com
gog auth add work@company.com
gog auth add sales@company.com
```

Each `gog auth add` opens a browser — authenticate each account one at a time. You can verify what's set up with:

```bash
gog auth list
```

You can also set up aliases for convenience:

```bash
gog auth alias personal personal@gmail.com
gog auth alias work work@company.com
```

During Hive setup, you'll be asked for your primary Google account email. The agent can access any authenticated account by specifying the `-a` flag — all accounts you've added to gog are available.

#### Verify it works

```bash
gog gmail search "is:unread" -a you@gmail.com
gog cal events --today -a you@gmail.com
```

### 5. Linear (Optional)

Get a personal API key from Linear: Settings > API > Personal API Keys.

## Memory

Agent memory (persistent knowledge, notes, and shared context like the constitution) is stored in **MongoDB** — not the filesystem. The `memory` collection holds current documents, and `memory_versions` keeps a version history of every change.

Agents read and write memory via the memory MCP server. Key paths:

| Path | Purpose |
|------|---------|
| `shared/constitution.md` | Team-wide rules and guidelines |
| `shared/business-context.md` | Business info seeded during setup |
| `agents/<id>/memory.md` | Per-agent persistent memory |

## Running Hive

```bash
# Production (compiled)
npm start

# Development (live reload)
npm run dev

# View logs
tail -f logs/stdout.log
```

### Run as a system service (starts on boot)

The setup wizard offers to install Hive as a launchd service. You can also do it manually:

```bash
bash service/install.sh
```

To manage the service:

```bash
# Stop
launchctl bootout gui/$(id -u)/com.dodi.hive

# Start
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.dodi.hive.plist

# Status
launchctl print gui/$(id -u)/com.dodi.hive
```

## Configuration

Hive uses two config files (both generated by the setup wizard):

### `.env` — secrets

```bash
SLACK_APP_TOKEN=xapp-...
SLACK_BOT_TOKEN=xoxb-...
# ANTHROPIC_API_KEY=sk-ant-...  # Leave blank if using Claude Max
# Plus optional: QUO_API_KEY, GOOGLE_ACCOUNT, LINEAR_API_KEY, etc.
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
```

See `hive.yaml.example` for all options including SMS lines and Quo phone configuration.

## Agents

Hive starts with a single **chief-of-staff** agent. Additional agents are created through it as your needs evolve — no need to configure them all upfront.

Agent definitions live in the `agents/` directory (per-instance, gitignored). Each agent has:

| File | Purpose |
|------|---------|
| `agent.yaml` | Name, model, Slack channels, MCP servers |
| `soul.md` | Personality, values, voice |
| `system-prompt.md` | Role definition, guidelines, tool instructions |

### Customizing agents

Edit any file in `agents/` — changes are picked up automatically (hot-reload). Templates in `agents-templates/` provide starting points, but once generated, agents are yours to customize.

### Regenerating agents from templates

If you want to re-generate agents from templates (e.g., after a Hive update adds new template features):

```bash
npm run setup:agents
```

This will warn you before overwriting any files you've customized.

## Dev vs Deploy

- **Dev**: `~/github/hive` — edit, test, commit, push
- **Deploy**: `~/services/hive` — separate clone, compiled JS, launchd points here
- **Deploy script**: `~/services/hive/deploy.sh` — pulls, installs, builds, syncs agents, restarts

Editing source in dev does NOT affect the running service.

## Updating

```bash
npm run update
```

This pulls the latest code, installs dependencies, and rebuilds. Your `hive.yaml`, `.env`, and customized `agents/` are preserved (they're gitignored).

## npm Scripts

| Script | What it does |
|--------|-------------|
| `npm start` | Start Hive (production, compiled) |
| `npm run dev` | Start Hive (development, live reload) |
| `npm run build` | Compile TypeScript |
| `npm run setup` | Run the interactive setup wizard |
| `npm run setup:prereqs` | Install Homebrew, Node.js, MongoDB, Git |
| `npm run setup:agents` | Regenerate agents from templates |
| `npm run setup:plist` | Regenerate the launchd plist |
| `npm run update` | Pull latest code, install deps, rebuild |
