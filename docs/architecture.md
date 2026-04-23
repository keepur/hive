# Dodi System Architecture

How the four repos work together to run Dodi's business.

```
┌─────────────────────────────────────────────────────────────────────┐
│                         DODI ECOSYSTEM                              │
│                                                                     │
│  ┌──────────┐    Slack     ┌──────────┐    REST/WS    ┌──────────┐ │
│  │          │◄────────────►│          │──────────────►│          │ │
│  │  HIVE    │   WebSocket  │  dodi_v2 │   MongoDB     │ iOS App  │ │
│  │ (agents) │──────────────►│ (platform)│◄─────────────│(shop app)│ │
│  │          │  task-ledger │          │               │          │ │
│  └────┬─────┘  catalog API └─────┬────┘               └──────────┘ │
│       │                          │                                  │
│       │  permit data    ┌────────┴───────┐                         │
│       │  CRM vectors    │   Marketing    │                         │
│       │◄────────────────│  (pipelines)   │                         │
│       │                 └────────────────┘                         │
└─────────────────────────────────────────────────────────────────────┘
```

---

## Repo Overview

| Repo | Path | What It Does | Tech Stack |
|------|------|-------------|------------|
| **Hive** | `~/github/hive` | Multi-agent orchestration — 9 AI agents that run the business via Slack | TypeScript, Claude Agent SDK, Slack Socket Mode, MCP servers |
| **dodi_v2** | `~/dev/dodi_v2` | Kitchen cabinet design & fabrication platform — customer-facing + internal ops | Meteor 3, React, Babylon.js, MongoDB, TypeScript |
| **dodi-shop-ios** | `~/github/dodi-shop-ios` | Native iOS chat for shop floor workers to talk to Hive agents | Swift, SwiftUI, SwiftData, WebSocket |
| **marketing** | `~/github/marketing` | Automated lead generation — permit scraping, Reddit monitoring, HubSpot ETL | Node.js, Playwright, MongoDB, Claude API |

---

## 1. Hive — Agent Orchestration

**Purpose**: Run 9 AI agents (Mokie, Jasper, Rae, River, Jessica, Milo, Chloe, Colt, Wyatt) that coordinate business operations through Slack.

**Key components**:
- **Gateway** (`src/channels/slack/`) — Slack Socket Mode listener, routes messages to agents
- **Agent Runner** (`src/agents/`) — Spawns Claude sessions with per-agent system prompts, MCP servers, and model config
- **MCP Servers** (`src/*/`) — 15+ tool servers (memory, linear, slack, catalog, resend, contacts, hubspot, google, drive, permits, keychain, etc.)
- **WebSocket Channel** (`src/channels/ws/`) — Backend for iOS shop app connections
- **Model Router** — Per-turn Haiku classifier for dynamic model selection (Haiku vs Sonnet)

**Runtime**: Node 24 on Mac Mini, `launchd` service (`com.hive.<instance>.agent`).
- Dev: `~/github/hive` (edit/commit/push; repo layout unchanged from 0.1.x — `dist/` + `node_modules/` at repo root)
- Deploy: `~/services/hive/<instance>/` (instance dir; engine in `<instance>/.hive/`, upgraded via `hive update` → npm tarball fetch → `.hive/` swap; rollback via `hive rollback`)

**Instance layout** (customer installs, post-0.2.x):

```
~/services/hive/<instance>/
  .hive/                         # engine — wipe-and-replace on upgrade
    pkg/ seeds/ templates/
    service/                     # deploy.sh + instances.conf (engine-shipped)
    scripts/honeypot
    node_modules/                # prod deps (populated on fetch)
    package.json
    plugins/claude-code/         # built-in engine plugins
  .hive.prev/                    # previous engine (rollback target; may be absent)
  .env                           # instance config — survives upgrades
  hive.yaml
  beekeeper.yaml
  .hive-generated.json           # seed-hash cache — survives upgrades
  logs/                          # observability — survives upgrades
  agents/<agent_id>/             # per-agent home — survives upgrades
    scratch/ reports/ feeds/ playwright/
    workshop/                    # software-engineer archetype only
  workflow/                      # instance-authored flows
  data/                          # pipeline dump ground — transient
  skills/                        # instance-authored skills
  plugins/                       # instance-authored plugins (from `hive plugin add`)
```

Engine files live under `.hive/` and are replaced atomically on upgrade. Everything at the instance root (config, agent data, logs, workflow, skills, instance plugins) survives upgrades.

**Agent model tiers**: Opus (Mokie), Sonnet (River, Jessica, Jasper, Colt, Wyatt), Haiku (Rae, Chloe, Milo)

---

## 2. dodi_v2 — Product Platform

**Purpose**: Design custom kitchen cabinets in 3D, generate quotes, manage production through CNC fabrication, track orders.

**Two apps sharing one MongoDB**:
- **Ops App** (port 3002) — Main app for sales, design, production, purchasing. Four shells: internal desktop/mobile, customer desktop/mobile
- **Sysadmin App** (port 3001) — Migrations, deploy checklists, API key management, Atlas Search admin

**19 modules** organized as internal packages (`@dodihome/*`, `@dodi/*`):
- **Core domain**: core (FSM, events), system (users, permissions, S3), designer (3D engine, BOM), catalog (parts, vendors)
- **Business process**: project (quotes, sales), production (jobs, cutlists), operations (purchasing, receiving), tasks, workflow, communications
- **AI**: LLM abstraction (Claude, GPT, Gemini, Grok), 40+ designer tools for AI-assisted cabinet design
- **UI**: React components, 2D design editor, flow/BPMN editor

**Deployment**: GitHub Actions CI on self-hosted DigitalOcean runner. Branch strategy: `master` (integration) → `deploy/production` (live).

**Database**: MongoDB (local dev: `localhost:27017/master`, production: Atlas)

---

## 3. dodi-shop-ios — Shop Floor App

**Purpose**: Give warehouse/shop workers a native iOS chat interface to Hive agents without needing Slack.

**Key features**:
- Text, voice (multilingual STT/TTS — English, Chinese, Spanish), and photo input
- Offline-first with SwiftData persistence and sync queue
- Large touch targets for gloved hands, voice-first input for noisy environments
- Thread management (create, rename, delete)

**Connection**: WebSocket to Hive at `wss://shop.dodihome.com`
- Pairing via 6-digit code → JWT auth stored in Keychain
- Messages flow: iOS app → WebSocket → Hive gateway → agent → response back via WebSocket
- Photos sent as base64 JPEG

**No direct connection to dodi_v2** — all interaction goes through Hive agents.

---

## 4. Marketing — Lead Generation Pipelines

**Purpose**: Automated pipelines that find and qualify potential customers, then feed leads to agents.

**Three pipelines**:

### Permit Monitor (`projects/permit-monitor/`)
- Scrapes 28 Bay Area city permit databases (Accela, eTRAKiT, EnerGov, SODA, CKAN) via REST APIs + Playwright
- Filters for kitchen/remodel projects, scores with Claude AI (1-10)
- Enriches with BatchData skip-trace (owner name/phone/email from address) and SF assessor data
- Delivers qualified leads to Slack via webhook
- Runs nightly at 1 AM via crontab

### Reddit Monitor (`projects/reddit-monitor/`)
- Monitors relevant subreddits for keyword matches
- Claude summarizes posts, generates daily digest to Slack

### HubSpot Pipeline (`projects/hubspot-pipeline/`)
- Extracts all HubSpot CRM data (contacts, deals, tasks, notes, calls, emails, meetings)
- Stages in Atlas `staging_*` collections
- Generates Voyage AI vector embeddings in `rag_*` collections
- Makes CRM, design, and production data semantic-searchable by Hive agents via `knowledge-base` MCP server
- Runs nightly at 3 AM via crontab

---

## How They Connect

### Hive ↔ dodi_v2

| Connection | Direction | Mechanism |
|-----------|-----------|-----------|
| **Task Ledger** | Hive → dodi_v2 | REST API (`x-api-key` auth). Agents create/update tasks in dodi_v2's task system |
| **Catalog** | Hive → dodi_v2 | REST API (`x-api-key` auth). Wyatt queries parts, families, pricing from dodi_v2's catalog module |
| **Linear** | Both | Shared Linear workspace. Agents track dev work; dodi_v2 CI auto-creates issues on failure |

No direct database sharing. All communication is via authenticated REST APIs.

### Hive ↔ iOS App

| Connection | Direction | Mechanism |
|-----------|-----------|-----------|
| **WebSocket** | Bidirectional | `wss://shop.dodihome.com`. Real-time chat between shop workers and agents |
| **REST** | iOS → Hive | Pairing (`POST /pair`), device management (`GET/PUT /me`) |

The iOS app is a thin client — all intelligence lives in Hive.

### Hive ↔ Marketing

| Connection | Direction | Mechanism |
|-----------|-----------|-----------|
| **Knowledge Base** | Marketing → Atlas → Hive | HubSpot pipeline writes vector embeddings to Atlas; Hive's `knowledge-base` MCP server queries them for CRM, design, and production data |
| **Permits** | Marketing → MongoDB → Hive | Permit monitor writes to local MongoDB; Hive's `permits` MCP server reads them |
| **Slack** | Marketing → Slack → Hive | Lead digests posted to Slack channels that agents monitor |

Marketing pipelines are upstream data producers. They don't call Hive directly — data flows through shared databases and Slack.

### dodi_v2 ↔ Marketing

| Connection | Direction | Mechanism |
|-----------|-----------|-----------|
| **HubSpot Sync** | Marketing → dodi_v2 | `hubspot-sync.ts` can transform HubSpot data to dodi_v2 schemas (not yet in production) |
| **Shared MongoDB Atlas** | Both | Same Atlas cluster, different databases (`master` for dodi_v2, `hubspot` for marketing) |

---

## Data Flow: Lead to Customer

```
Permit filed in Bay Area city
        │
        ▼
[Marketing: Permit Monitor]
  scrape → filter → AI score → skip-trace → Slack digest
        │
        ▼
[Hive: Agents read Slack]
  Milo (SDR) or River (Marketing) pick up lead
        │
        ▼
[Hive: Agent actions]
  Look up in CRM (knowledge-base) → draft outreach (resend) → create deal (hubspot-crm)
        │
        ▼
[dodi_v2: Design & Production]
  Customer designs cabinets → quote → order → production → delivery
        │
        ▼
[iOS App: Shop Floor]
  Workers chat with Jessica (Customer Success) about production status
```

---

## Shared Infrastructure

| Service | Used By | Purpose |
|---------|---------|---------|
| **MongoDB Atlas** | dodi_v2, marketing, hive (memory) | Primary database cluster |
| **MongoDB Local** | marketing (permits) | Permit dedup and contractor data |
| **Slack** | hive, marketing | Agent communication + lead delivery |
| **Linear** | hive, dodi_v2 CI | Issue tracking |
| **GitHub** | all repos | Source control, CI/CD |
| **HubSpot** | marketing, hive (via MCP) | CRM |
| **AWS S3** | dodi_v2 | File storage |
| **Resend** | hive, dodi_v2 | Outbound email |
| **Google Workspace** | hive (via MCP) | Drive, Gmail, Calendar |

---

## Deployment Summary

| Repo | Where It Runs | How It Deploys |
|------|--------------|----------------|
| **Hive** | Mac Mini (`launchd`) | `hive update [--tag=X]` shells to `<instance>/.hive/service/deploy.sh` — fetches npm tarball, swaps `.hive/` ↔ `.hive.prev/`, restarts. Rollback via `hive rollback`. |
| **dodi_v2** | DigitalOcean | GitHub Actions CI on PR merge to `master`, manual deploy to `deploy/production` |
| **iOS App** | User devices | Xcode → TestFlight |
| **Marketing** | Mac Mini (crontab) | Nightly cron jobs at 1 AM (permits) and 3 AM (HubSpot) |
