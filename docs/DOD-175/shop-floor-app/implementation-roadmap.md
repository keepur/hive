# Implementation Roadmap: Shop Floor WS Adapter

## Design Summary

Add a WebSocket channel adapter to Hive that enables non-Slack clients (initially an iOS app) to communicate with agents. Follows the same `ChannelAdapter` pattern as `SlackAdapter` and `SmsAdapter`.

### Technical Decisions
- **Transport**: Raw WebSocket (native `ws` or Node built-in) over HTTP server
- **Auth**: JWT tokens issued via 6-digit pairing code exchange
- **Storage**: MongoDB `devices` collection for device registry
- **Images**: Reuse `file-processor.ts` Gemini vision pipeline (base64 -> buffer -> describe)
- **Port**: Configurable, default `3200` (avoids conflict with background task manager on 3100)
- **Protocol**: JSON messages with type discriminator field

### Architecture
```
iOS App -> WSS -> Cloudflare Tunnel -> Mac Mini:3200 -> WsAdapter -> Dispatcher -> Agents
                                                                  <- WorkResult <- Agent
```

## Implementation Phases

### Phase 1: Foundation (this PR)
1. Protocol types (`src/channels/ws/protocol.ts`)
2. Device registry (`src/channels/ws/device-registry.ts`)
3. WS adapter (`src/channels/ws/ws-adapter.ts`)
4. Config + wiring (`src/config.ts`, `src/index.ts`, `src/types/work-item.ts`)

### Phase 2: Infrastructure (separate)
- Cloudflare tunnel: `shop.dodihome.com` -> `localhost:3200`
- LaunchAgent for `cloudflared`

### Phase 3: iOS App (separate repo)
- SwiftUI app with chat, voice, camera

## Dependencies
- `jsonwebtoken` npm package (JWT sign/verify)
- Node `http` + `ws` packages for WebSocket server
- MongoDB driver (already in project)

## Risks
- Port conflict with background task manager (mitigated: use 3200)
- JWT secret management (mitigated: env var, required only when WS enabled)
- WebSocket reconnection storms (mitigated: client-side backoff, server-side rate limiting)
