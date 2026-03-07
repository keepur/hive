# User Story: Shop Floor Mobile App

## Story

As a **production/shop floor worker**, I want a **simple mobile chat interface** to talk to Hive agents, so that I can get answers, report issues, and share photos without needing Slack.

## Context

Slack is too complex for shop floor use. Workers need large tap targets (gloves/dirty hands), voice-first input (noisy environment), and offline resilience. This feature adds a WebSocket-based channel adapter to Hive's backend, enabling a native iOS app to communicate with agents through the same dispatcher pipeline.

## Acceptance Criteria

### Backend (WebSocket Adapter)
- [ ] New `WsAdapter` implements `ChannelAdapter` interface
- [ ] HTTP server on configurable port (default 3100 — shares with background tasks or separate port)
- [ ] WebSocket upgrade at `/ws` with JWT authentication
- [ ] Device pairing: `POST /pair` accepts 6-digit code, returns JWT
- [ ] Device registry persisted in MongoDB (`hive.devices` collection)
- [ ] Incoming text messages create `WorkItem` and dispatch to agents
- [ ] Incoming images (base64) saved to temp, processed via Gemini vision (reuse `file-processor.ts` pipeline)
- [ ] Agent responses delivered back over WebSocket as JSON
- [ ] Typing indicators sent when agent is processing
- [ ] Message acknowledgments (`ack`) sent on receipt
- [ ] `"app"` added to `ChannelKind` union type
- [ ] Adapter registered in `index.ts`, wired to dispatcher
- [ ] Config section in `config.ts` for WS port, JWT secret, pairing codes
- [ ] Graceful shutdown closes all WebSocket connections
- [ ] Triage gate works for `"app"` channel kind (interactive)

### Protocol
- [ ] Client-to-server: `message`, `image`, `ping` types
- [ ] Server-to-client: `message`, `ack`, `typing`, `error` types
- [ ] All messages have `id` field for correlation

## Out of Scope (v1)
- iOS app implementation (separate project/repo)
- Cloudflare tunnel setup (infra task)
- Push notifications
- Multiple conversations/threads per device
- Message history sync
- Audio messages (future: raw audio for server-side STT)
- User profiles beyond device pairing
