# Beekeeper Device Pairing

**Date**: 2026-03-31
**Status**: Draft
**Author**: May + Claude Code

## Problem

Beekeeper authenticates via a static shared token (`BEEKEEPER_AUTH_TOKEN`). If the token leaks, the only fix is rotating it in both `.env` and the iOS client. There is no way to revoke a single device, audit connections, or manage access granularly.

The shop app (dodi-shop-ios) already solves this problem: admin creates a device, gets a 6-digit pairing code, client exchanges code for a JWT, uses JWT for WebSocket auth. Beekeeper should use the same pattern.

## Design

Replace `BEEKEEPER_AUTH_TOKEN` with a device pairing flow. Beekeeper gets its own `DeviceRegistry`, its own MongoDB collection (`beekeeper_devices`), and its own JWT secret separate from the shop app.

### New File: `src/beekeeper/device-registry.ts`

Own class, own collection. Same API surface as `src/channels/ws/device-registry.ts` but without `defaultAgentId` (beekeeper doesn't route to agents).

**Constructor**: `(mongoUri: string, dbName: string, jwtSecret: string)`

**Methods**:

| Method | Description |
|--------|-------------|
| `connect()` | Opens MongoDB, creates sparse index on `pairingCode` |
| `createDevice(name)` | Generates UUID `_id`, 6-digit numeric code (randomInt 100000-999999), 10-minute TTL, `active: true`. Returns device with code. |
| `verifyPairingCode(code, name?)` | Validates code + expiry, clears code fields, sets `pairedAt`, generates 90-day JWT. Returns `{ device, token }`. |
| `verifyToken(token)` | Decodes JWT, fetches device by ID with `active: true`. Returns Device or null. |
| `refreshPairingCode(deviceId)` | Generates new 6-digit code with 10-minute TTL |
| `listDevices()` | Returns all devices |
| `getDevice(deviceId)` | Fetch by ID |
| `updateDevice(deviceId, fields)` | Update device fields (e.g. name) |
| `deactivateDevice(deviceId)` | Sets `active: false` |
| `updateLastSeen(deviceId)` | Updates `lastSeenAt` |
| `close()` | Closes MongoDB connection |

**Device document shape**:

```typescript
interface BeekeeperDevice {
  _id: string;                      // UUID
  name: string;                     // User-facing device name
  pairingCode?: string;             // 6 digits, cleared on pairing
  pairingCodeExpiresAt?: Date;      // Expiry time
  createdAt: Date;
  lastSeenAt: Date;
  pairedAt?: Date;
  active: boolean;
}
```

### Config Changes

**`src/beekeeper/config.ts` + `types.ts`**:

Remove `authToken` from `BeekeeperConfig`. Add:

| Field | Source | Description |
|-------|--------|-------------|
| `jwtSecret` | `BEEKEEPER_JWT_SECRET` env var | Signs device JWTs |
| `adminSecret` | `BEEKEEPER_ADMIN_SECRET` env var | Authenticates admin API calls (separate from JWT secret -- fixes the conflation the shop app has) |
| `mongoUri` | `MONGO_URI` env var | Same MongoDB instance as Hive |
| `mongoDbName` | `beekeeper.yaml` field `mongo_db` | Database name (default: `hive`) |

Drop `BEEKEEPER_AUTH_TOKEN` requirement.

### HTTP Endpoints (Port 3099)

Added to `src/beekeeper/index.ts` HTTP server alongside the existing `/health` endpoint.

**Public (no auth)**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/health` | Already exists, keep as-is |
| `POST` | `/pair` | Exchange pairing code for JWT. Body: `{ code, name? }`. Returns `{ token, deviceId, deviceName }` or 401. |

**Device auth (Bearer JWT)**:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/me` | Get own device info |
| `PUT` | `/me` | Update own device name |

**Admin auth (Bearer BEEKEEPER_ADMIN_SECRET)**:

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/devices` | Create device. Body: `{ name? }`. Returns `{ deviceId, name, pairingCode, expiresAt }` |
| `GET` | `/devices` | List all devices with connection status |
| `PUT` | `/devices/:id` | Update device name |
| `DELETE` | `/devices/:id` | Deactivate device + disconnect if connected |
| `POST` | `/devices/:id/refresh-code` | Generate new pairing code |

### WebSocket Upgrade Auth Change

Replace static token check with device verification:

```typescript
// Before
if (token !== config.authToken) { ... 401 ... }

// After
const device = await deviceRegistry.verifyToken(token);
if (!device) { ... 401 ... }
```

Token extraction stays the same: `?token=` query param or `Authorization: Bearer` header.

On successful connection, update `lastSeenAt`. Store `activeDeviceId` alongside `activeClient` so that `DELETE /devices/:id` can force-disconnect the matching client.

### Startup and Shutdown

Startup becomes `async function main()`:

1. `loadConfig()`
2. `deviceRegistry = new BeekeeperDeviceRegistry(...)`
3. `await deviceRegistry.connect()` — fail to start if MongoDB is unreachable
4. `server.listen(config.port)` — only accept connections after registry is ready

Graceful shutdown (`SIGTERM`/`SIGINT`) must call `await deviceRegistry.close()` before `process.exit()`.

### What Stays the Same

- Single-client connection behavior (new connection replaces old) -- multi-session is a separate future effort
- Tool guardian, session manager, output buffering -- unchanged
- WebSocket protocol messages -- unchanged
- Client-side: keepur-ios already stores token in Keychain, already has pairing UI patterns from dodi-shop-ios to reference

### Migration

1. Remove `BEEKEEPER_AUTH_TOKEN` from `.env` in both dev and deploy
2. Add `BEEKEEPER_JWT_SECRET` and `BEEKEEPER_ADMIN_SECRET` to `.env` in both dev and deploy
3. Add `mongo_db` field to `beekeeper.yaml` (or default to `hive`)
4. iOS app: update to use pairing flow instead of hardcoded token (separate PR in keepur-ios)

### Security Notes

- **Separate secrets**: Admin secret is separate from JWT signing secret -- knowing a device JWT does NOT grant admin access
- **One-time codes**: Pairing codes are single-use, 10-minute TTL
- **Immediate revocation**: Device deactivation takes effect immediately (`verifyToken` checks `active: true`)
- **JWT expiry**: 90 days
- **No shell execution**: All MongoDB access via driver, following DOD-212
- **Timing-safe comparison**: Admin secret checked via `crypto.timingSafeEqual()`, not `===`
- **Rate limiting**: Not implemented — acceptable risk since beekeeper is behind Cloudflare Tunnel on a private network. 6-digit codes with 10-minute TTL limit brute-force window.

## Out of Scope

- Multi-session support (server-side session map) -- separate ticket
- Multi-client simultaneous connections -- separate ticket
- Token refresh/rotation mechanism
