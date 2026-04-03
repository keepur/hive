# Hive Appliance — Vision & Architecture

**Date**: 2026-03-28
**Status**: Vision (not yet a spec)
**Author**: May + Claude Code

## The Idea

The Hive is a **self-contained edge appliance**. A Mac Mini that runs an entire AI-powered workplace — agents, communication, data, and operations — on dedicated hardware. The cloud is an enhancement, not a dependency.

The iOS app is the primary access layer. No Slack dependency. No Microsoft 365 dependency. No Google Workspace dependency. Install the app, connect to the Mac Mini, you're up and running.

## Why This Matters

### For the target buyer (SMB: cabinet shops, law firms, medical practices, family offices)

- **Corporate IT can't block it** — it's your own app talking to your own device. IT never sees it as a threat because it's not touching their systems.
- **Internet goes down, work continues** — the Mac Mini is the server. Agents keep working, chat keeps working, tasks keep moving. Every cloud-dependent tool (Slack, Teams, Notion) stops. The Hive doesn't.
- **Sensitive data never leaves** — PII, financials, client data stay on the box. Not a policy promise — an architectural guarantee enforced at the OS level.
- **The security model is macOS, not custom code** — auditable, explainable, and trustworthy to security-conscious buyers in a way that "we implemented our own sandboxing" never is.

### The pitch

> "The Hive runs on your hardware. Sensitive data never leaves. When the internet goes down, your team keeps working. And when something needs fixing, there's a backdoor only you control."

## Three Trust Domains, One Box

The Mac Mini runs three OS-level users, each with different privileges and network access. Security boundaries are enforced by macOS, not by application code.

| User | Privileges | Runs | Trust Level |
|------|-----------|------|-------------|
| `hive` | Standard | Meteor, agents, MongoDB | Workspace — normal operations |
| `vault` | Standard, **no outbound network** | Local model, Vault socket | Air-gapped — sensitive data never leaves |
| `beekeeper` | Sudo | Claude Code, deploy scripts | God mode — full system access |

### Why OS-level separation

- macOS audit logs per user — you know exactly what each domain touched
- Little Snitch / firewall rules per user — Vault's outbound is blocked at the OS level, not in software
- If `hive` is ever compromised, it literally cannot reach `vault` or `beekeeper`
- Time Machine can back up `hive` data normally, exclude or separately encrypt Vault data
- Privilege escalation between domains is prevented by the OS, not by your code

## Three Channels, Three Sockets

The iOS app connects to three separate WebSocket endpoints on the Mac Mini. Each has its own auth, connection lifecycle, and guarantees.

```
:3099 — Beekeeper socket (Claude Code, external session connects in)
:TBD  — Meteor (main workspace, agents, collaboration)
:TBD  — Vault socket (local model, never leaves box)
```

Each socket uses whatever protocol makes sense. Beekeeper doesn't need DDP — raw WebSocket optimized for streaming code and logs. Meteor uses DDP natively. Vault can be minimal.

### Channel routing

| Channel | Routes to | Purpose |
|---------|-----------|---------|
| Regular workspace | Hive agents (Claude via cloud) | Normal work, collaboration |
| Sensitive/private | Local model only (on-device) | PII, financials, anything that can't leave the edge |
| Beekeeper | Claude Code session | Dev ops, agent debugging, deploys, system management |

## The Workspace (Meteor)

Meteor is the main workspace — the Hive's own communication and collaboration layer, replacing Slack as the primary interface.

### Why Meteor

- DDP (Distributed Data Protocol) is a built-in real-time sync layer — publications/subscriptions handle push messaging without WebSocket plumbing
- MongoDB is its native store (already running on the Mac Mini)
- Single-instance deployment is exactly what it was designed for
- Works on local WiFi with zero cloud dependency

### Data model

```
users          — humans and agents alike, isAgent flag for UI hints only
channels       — persistent channels (#general, #projects, etc.)
rooms          — meeting rooms, ephemeral, have a lifecycle (open → closed)
messages       — { spaceId, senderId, body, createdAt }
presence       — { spaceId, userId, joinedAt }
```

- `spaceId` unifies channels and rooms — a message doesn't care which kind of space it lives in
- Agents are participants, not special entities. Join = insert, leave = remove. Equal rights.
- Meeting rooms: `status: open | closed`. Close a room → presence gets cleared → transcript becomes a query (`Messages.find({ roomId, createdAt: { $gte: meetingStart, $lte: meetingEnd } })`)
- Agent DDP integration: agents connect via the same DDP protocol, subscribe to room message streams, publish back

### Slack becomes optional

Slack (and Teams, Google Workspace, etc.) become optional connectors for enrichment, not requirements. The Hive's own app is the primary interface.

## The Vault (Local Model + Sensitive Data)

A separate process under a separate OS user with **no outbound network access**. Handles information that must never touch an external API.

### What it handles
- Passwords, API keys, secrets → stored in macOS Keychain
- Credit card numbers, PII, financial data
- Any content the user explicitly routes to the sensitive channel

### How it works
- Local model (7-8B, e.g., Llama, Phi) runs on Apple Silicon — fast enough for structured tasks
- The model doesn't need to be smart. Its job: classify intent, extract structured data, write to Keychain
- Air gap enforced at OS level (Little Snitch or firewall rules on the `vault` user), not in software

### Keychain as the trust bridge
- `vault` and `hive` never share a file, pipe, or socket for data exchange
- They share secrets through macOS Keychain, which enforces access control at the OS level
- Vault processes a message → drops the result into Keychain → Hive picks it up
- The handoff is atomic and auditable. No shared memory, no temp files, no custom IPC

### Usage without leaking secrets
- Wherever possible, wrap secret usage in opaque tools/scripts — the agent calls `call_service_x_api(endpoint, params)` and the credential is injected internally, never surfacing in the LLM context
- Env-var injection at MCP subprocess spawn — pull from Keychain at process start
- Some leakage is acceptable for interactive use (e.g., "what's the wifi password?") — conscious per-secret decision

## The Beekeeper (Claude Code Backdoor)

A standalone relay service that bridges the iOS app to a Claude Code CLI session. Sits **outside** the Hive — it builds, deploys, and manages the Hive. If the Hive is half-broken, Beekeeper can still reach it.

**Full spec**: `docs/specs/2026-03-28-beekeeper-relay-design.md`

Key properties:
- Separate process, separate LaunchAgent, port 3099
- Claude Code SDK for structured session management
- `bypassPermissions: true` with a Tool Guardian for destructive operations
- Single user (May), static auth token
- Persistent sessions that survive phone disconnects
- Configurable workspaces (hive, ios, dodi, marketing)

## Internet-Down Resilience

The local 7-8B model is not a "good enough fallback" — it's the **guaranteed operational floor**. Cloud LLMs are the ceiling you reach for when available.

### What the local model handles (80% of daily work)
- Routing and assigning tasks
- Taking dictation, adding comments to jobs
- Sending internal notifications (all local anyway)
- Answering "what's the status of order #4821?"
- Updating job stages, flagging blockers
- Triaging incoming messages, summarizing threads

### What queues for cloud
- Strategy, proposals, complex analysis
- Customer-facing emails that need polish
- Anything requiring deep reasoning

### Routing classification

Every agent action gets tagged at routing time:

```
routingClass: 'local' | 'cloud' | 'either'
```

`either` tasks automatically failover to local when cloud is unreachable. The user never thinks about it — the Hive degrades gracefully. A subtle banner: *"Running on local model — full AI resumes when connection restores."*

## iOS App

The iOS app is the crafted artifact — the thing executives touch daily. Native Swift, not a web wrapper.

### Connection strategy
- **Local WiFi first** — mDNS/Bonjour discovers the Mac Mini on local network automatically, no IP configuration
- **Tailscale as remote fallback** — when away from the office
- **Connection mode indicator** — subtle UI showing "local" vs "remote"

### Three channels
Each channel connects to a different socket on the Mac Mini. The app switches based on which channel the user is in.

### v1 features (per channel)
- **Workspace**: channels, messaging, meeting rooms, agent interaction
- **Vault**: secure input for sensitive data, confirmation UX
- **Beekeeper**: chat with Claude Code, tool approval prompts, workspace switcher

### v2 features
- Conversational voice interface (continuous STT, turn detection, TTS)
- Push notifications via APNs (local — the Mac Mini sends directly)

## The Historical Arc

The mainframe → PC transition happened because compute got cheap enough to put on a desk. The cloud → edge transition is happening because *intelligence* got cheap enough to put on a desk.

The Hive is a **personal mainframe** for a small team. Powerful enough to run the operation. Connected when useful. Sovereign when not.

## Implementation Sequence

| Phase | What | Depends on |
|-------|------|-----------|
| **Now** | Beekeeper relay (spec ready) | Nothing — standalone |
| **Next** | Beekeeper iOS app (v1, text + tool approval) | Beekeeper relay |
| **Then** | Vault design + local model integration | Research: model selection, Keychain IPC pattern |
| **Then** | Meteor workspace backend | Architecture decision on Meteor + DDP |
| **Then** | Unified iOS app (three channels) | All three sockets operational |
| **Later** | Conversational voice interface | iOS app foundation |
| **Later** | OS-level user separation (`hive`, `vault`, `beekeeper`) | All components stable |
| **Later** | Bonjour/mDNS local discovery | iOS app + local network |

Each phase gets its own spec → plan → implementation cycle.
