# Implementation Specs: Shop Floor WS Adapter

## Files to Create

### 1. `src/channels/ws/protocol.ts` — Protocol Types

```typescript
// Client -> Server message types
export interface ClientTextMessage {
  type: "message";
  text: string;
  id: string;
}

export interface ClientImageMessage {
  type: "image";
  data: string; // base64
  filename: string;
  id: string;
}

export interface ClientPing {
  type: "ping";
}

export type ClientMessage = ClientTextMessage | ClientImageMessage | ClientPing;

// Server -> Client message types
export interface ServerTextMessage {
  type: "message";
  text: string;
  agentId: string;
  agentName: string;
  replyTo?: string; // correlates to client message id
}

export interface ServerAck {
  type: "ack";
  id: string;
}

export interface ServerTyping {
  type: "typing";
  agentId: string;
}

export interface ServerError {
  type: "error";
  message: string;
}

export type ServerMessage = ServerTextMessage | ServerAck | ServerTyping | ServerError;
```

### 2. `src/channels/ws/device-registry.ts` — Device Registry

MongoDB collection: `devices`

```typescript
export interface Device {
  _id: string;        // generated UUID
  name: string;       // e.g. "Shop Floor iPad 1"
  pairingCode?: string;
  pairingCodeExpiresAt?: Date;
  jwtSecret: string;  // per-device secret
  defaultAgentId: string; // which agent this device talks to
  createdAt: Date;
  lastSeenAt: Date;
  active: boolean;
}
```

**Methods:**
- `createDevice(name: string, defaultAgentId: string): Promise<Device>` — creates device + generates 6-digit pairing code (expires 10 min)
- `verifyPairingCode(code: string): Promise<{ device: Device; token: string } | null>` — validates code, issues JWT, clears code
- `verifyToken(token: string): Promise<Device | null>` — validates JWT, returns device
- `refreshPairingCode(deviceId: string): Promise<string>` — generates new 6-digit code
- `updateLastSeen(deviceId: string): Promise<void>`
- `listDevices(): Promise<Device[]>`

JWT payload: `{ deviceId: string; iat: number }`
JWT signed with a global `WS_JWT_SECRET` env var.

### 3. `src/channels/ws/ws-adapter.ts` — WebSocket Adapter

Implements `ChannelAdapter` interface.

**Constructor params:**
- `port: number`
- `deviceRegistry: DeviceRegistry`
- `jwtSecret: string`

**Key behavior:**

`start(onWorkItem)`:
- Create HTTP server
- `POST /pair` endpoint: accepts `{ code: string }`, returns `{ token: string, deviceId: string, deviceName: string }`
- `GET /health` endpoint: returns `{ status: "ok", connections: number }`
- WebSocket upgrade at `/ws`: validate JWT from `?token=` query param or `Authorization` header
- On valid connection: store in `Map<string, WebSocket>` keyed by deviceId
- On message: parse JSON, validate, create WorkItem, call onWorkItem callback
- On close: remove from connections map

`deliver(result: WorkResult)`:
- Find WebSocket connection by deviceId (from `result.workItem.meta.deviceId`)
- Send `ServerTextMessage` JSON
- If connection gone, log warning (no retry — device will reconnect)

`onProcessingStart(item)`:
- Send `ServerTyping` to the device's WebSocket

`stop()`:
- Close all WebSocket connections
- Close HTTP server

**WorkItem construction:**
```typescript
{
  id: crypto.randomUUID(),
  text: message.text,
  source: {
    kind: "app",
    id: deviceId,
    label: `app:${device.name}`,
    adapterId: "ws",
  },
  sender: deviceId,
  senderName: device.name,
  threadId: `app:${deviceId}`, // one continuous conversation per device
  timestamp: new Date(),
  meta: {
    deviceId,
    defaultAgentId: device.defaultAgentId,
  },
}
```

**Image handling:**
- Receive base64 from `ClientImageMessage`
- Decode to Buffer
- Save to temp dir (reuse `DOWNLOAD_DIR` pattern from file-processor)
- Call `describeImageWithGemini(buffer, mimetype)` — need to export this from file-processor
- Attach as `ProcessedFile` on the WorkItem's `files` array

## Files to Modify

### 4. `src/types/work-item.ts`

Add `"app"` to ChannelKind:
```typescript
export type ChannelKind = "slack" | "sms" | "email" | "scheduler" | "callback" | "internal" | "app";
```

### 5. `src/config.ts`

Add `ws` config section:
```typescript
ws: {
  enabled: optional("WS_ENABLED", "false") === "true",
  port: parseInt(optional("WS_PORT", "3200"), 10),
  jwtSecret: optional("WS_JWT_SECRET", ""),
},
```

### 6. `src/index.ts`

After SMS adapter block, add:
```typescript
// WebSocket adapter — mobile app channel
if (config.ws.enabled && config.ws.jwtSecret) {
  const { DeviceRegistry } = await import("./channels/ws/device-registry.js");
  const { WsAdapter } = await import("./channels/ws/ws-adapter.js");

  const deviceRegistry = new DeviceRegistry(config.mongo.uri, config.mongo.dbName);
  await deviceRegistry.connect();

  const wsAdapter = new WsAdapter(config.ws.port, deviceRegistry, config.ws.jwtSecret);
  dispatcher.registerAdapter(wsAdapter);
  await wsAdapter.start((item) => {
    dispatcher.dispatch(item).catch((err) => {
      log.error("WS dispatch failed", { error: String(err), source: item.source.label });
    });
  });
  log.info("WebSocket adapter started", { port: config.ws.port });

  // Add to shutdown
  // wsAdapter.stop() in shutdown handler
}
```

Add `"app"` to the interactive channel check in dispatcher.ts:
```typescript
const isInteractive = (item.source.kind === "slack" || item.source.kind === "sms" || item.source.kind === "app") && item.sender !== "system";
```

### 7. `src/channels/dispatcher.ts`

Update triage gate to include `"app"` as interactive:
```typescript
const isInteractive = (item.source.kind === "slack" || item.source.kind === "sms" || item.source.kind === "app") && item.sender !== "system";
```

Update audit log icon for app:
```typescript
const icon =
  result.workItem.source.kind === "sms" ? ":phone:" :
  result.workItem.source.kind === "app" ? ":iphone:" :
  ":incoming_envelope:";
```

### 8. `src/files/file-processor.ts`

Export `describeImageWithGemini` so ws-adapter can reuse it:
```typescript
export async function describeImageWithGemini(buffer: Buffer, mimetype: string): Promise<string | null> {
```
(Change from private to exported — it's already a standalone function)

Also export a helper to process a raw buffer (not Slack-specific):
```typescript
export async function processImageBuffer(
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<ProcessedFile> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const localPath = join(DOWNLOAD_DIR, `ws-${Date.now()}-${safeName}`);
  writeFileSync(localPath, buffer);

  const description = await describeImageWithGemini(buffer, mimetype);
  return {
    name: filename,
    mimetype,
    size: buffer.length,
    localPath,
    textContent: description ?? "[Image — could not extract description]",
    isImage: true,
  };
}
```

## Data Models

### MongoDB: `hive.devices`
```javascript
{
  _id: "uuid-string",
  name: "Shop Floor iPad 1",
  pairingCode: "482917",          // null after paired
  pairingCodeExpiresAt: ISODate,  // null after paired
  defaultAgentId: "chief-of-staff",
  createdAt: ISODate,
  lastSeenAt: ISODate,
  active: true
}
```

Index: `{ pairingCode: 1 }` (sparse, for lookup during pairing)

## Dependencies to Add

- `ws` — WebSocket server library (or use Node 22+ built-in if available)
- `jsonwebtoken` + `@types/jsonwebtoken` — JWT sign/verify

## Testing

- Unit test device registry (mock MongoDB)
- Integration test: connect with wscat, send message, verify WorkItem created
- Test pairing flow: create device -> get code -> exchange for JWT -> connect
- Test image handling: send base64 image -> verify Gemini called -> verify WorkItem has files
- Test reconnection: disconnect -> reconnect with same JWT -> verify works
- Test invalid JWT: reject connection
- Test expired pairing code: reject exchange
