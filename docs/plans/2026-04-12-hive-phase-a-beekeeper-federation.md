# Hive Phase A — Beekeeper Federation (Register + Internal WS)

**Date:** 2026-04-12
**Ticket:** [KPR-7](https://linear.app/keepur/issue/KPR-7)
**Spec:** `../../beekeeper/docs/specs/2026-04-12-pair-gateway-and-hive-federation.md`
**Scope:** Hive-side Phase A only. Additive; legacy paths keep working.

## Goal

Make Hive advertise itself to a sibling Beekeeper on the same box and accept proxied WS connections from it over loopback, without touching any of the existing legacy code paths (`*:3200` token auth, `/pair`, device registry, `src/beekeeper/`). Phase B deletes those after the cloudflared flip.

## Work breakdown

### 1. Config — `src/config.ts` + `hive.yaml`

- Add top-level `beekeeper` section in the typed config:
  ```ts
  beekeeper: {
    port: parseInt(optional("BEEKEEPER_PORT", String((hive.beekeeper as { port?: number })?.port ?? 8420)), 10),
  }
  ```
- Document in `hive.yaml.example` / README if those exist; otherwise just the typed default.
- No new required fields — default `8420` matches Beekeeper's default.

### 2. `src/beekeeper-client.ts` (new)

Small module, no class gymnastics. One exported function:

```ts
export function startBeekeeperRegistration(opts: {
  beekeeperPort: number;
  wsPort: number;
  intervalMs?: number; // default 30_000; test override only
}): { stop: () => void };
```

Behavior:
- Build payload once: `{ name: "hive", localWsUrl: "ws://127.0.0.1:<wsPort>", healthUrl: "http://127.0.0.1:<wsPort>/health" }`.
- `register()` helper: `fetch("http://127.0.0.1:<beekeeperPort>/internal/register-capability", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) })`. Log at debug on 200, warn on failure (with error text). Never throw — swallow and retry next tick.
- Call `register()` immediately, then `setInterval(register, 30_000)`.
- Return `{ stop: () => clearInterval(handle) }` for shutdown.

No exponential backoff, no jitter, no "is Beekeeper up" probe. 30s retry forever is the entire strategy — the spec calls this out explicitly.

### 3. `src/channels/ws/ws-adapter.ts` — accept `?internal=1` over loopback

Modify the upgrade handler (currently `src/channels/ws/ws-adapter.ts:341`):

```ts
this.server.on("upgrade", async (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);

  if (url.searchParams.get("internal") === "1") {
    const remote = req.socket.remoteAddress ?? "";
    const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
    if (!isLoopback) {
      socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
      socket.destroy();
      return;
    }
    const deviceId = url.searchParams.get("deviceId");
    const name = url.searchParams.get("name");
    if (!deviceId || !name) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    const device: Device = {
      _id: deviceId,
      name,
      defaultAgentId: "",
      // minimal synthetic device — Beekeeper only proxies channel=team traffic,
      // which always carries targetAgentId on the wire, so defaultAgentId is a
      // safety-net default and should never actually be read.
    } as Device;
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      (ws as WebSocket & { __internal?: boolean }).__internal = true;
      this.wss.emit("connection", ws, req, device);
    });
    return;
  }

  // ...existing token-auth path unchanged...
});
```

Then in the `connection` handler (`ws-adapter.ts:364`), guard **both** registry call sites:

```ts
// at top of connection handler, right after `const deviceId = device._id;`
const isInternal = (ws as WebSocket & { __internal?: boolean }).__internal === true;

// replace ws-adapter.ts:384
if (!isInternal) this.deviceRegistry.updateLastSeen(deviceId);

// replace ws-adapter.ts:395 (inside the `ping` branch)
if (!isInternal) this.deviceRegistry.updateLastSeen(deviceId);
```

Both sites must be updated — missing the ping-branch guard would silently fire a Mongo `updateOne` against a non-existent `_id` on every client ping. The "Replaced by new connection" close stays as-is so a collision between a legacy-authed socket and a proxied internal socket behaves the same as today.

**On team-message routing for internal connections.** Beekeeper only ever proxies with `?channel=team`, and the Team channel protocol requires clients to send `targetAgentId` on every message. The synthetic device's `defaultAgentId: ""` is a safety net for the fallback branches at `ws-adapter.ts:698,756,824` (`targetAgentId ? { targetAgentId } : { defaultAgentId: device.defaultAgentId }`). If a misbehaving client ever omits `targetAgentId` on an internal connection, the dispatcher will fail to resolve an empty-string agent and surface a clean error — much better than routing to `undefined`.

Everything else in the connection handler (team message routing, join/leave, handleCommand, etc.) runs identically for internal connections — Beekeeper proxies frames opaquely, Hive just sees a well-behaved WS peer.

### 4. Wire it in — `src/index.ts`

After the `wsAdapter.start(...)` call (`src/index.ts:355`), start the register loop:

```ts
const { startBeekeeperRegistration } = await import("./beekeeper-client.js");
const beekeeperRegistration = startBeekeeperRegistration({
  beekeeperPort: config.beekeeper.port,
  wsPort: config.ws.port,
});
```

Gate on `config.ws.enabled` — if the WS adapter isn't running, there's nothing to advertise.

In the shutdown path (`src/index.ts:445`), call `beekeeperRegistration.stop()` before `wsAdapter.stop()`.

### 5. Tests — `src/beekeeper-client.test.ts` + extend `ws-adapter.test.ts`

- **beekeeper-client.test.ts**: spin up a tiny http server on an ephemeral port that records POST bodies, start the registration loop pointed at it (with interval overridden to ~20ms via an optional test hook), assert it re-POSTs the same payload at least twice. Separate test: point at a dead port, assert no crash and the loop keeps running.
- **ws-adapter.test.ts** extensions: unit-level, driven through the upgrade handler with a fake `req`/`socket`. Three cases:
  1. `?internal=1` from `::ffff:127.0.0.1` accepted, `deviceId`/`name` surfaced on the emitted device.
  2. `?internal=1` from a non-loopback address → 403.
  3. Legacy `?token=<valid>` path still works with no `internal` param.

### 6. Manual integration smoke (documented in PR, not automated)

- Start local Beekeeper on `:8420` against a test SQLite.
- Start Hive on `:3200` with `beekeeper.port=8420`.
- Tail Hive logs: expect a debug line on registration success within 1s of startup.
- `curl -H "Authorization: Bearer <device-jwt>" http://localhost:8420/capabilities` → `{"capabilities":["beekeeper","hive"]}`.
- Open `ws://localhost:8420/?token=<jwt>&channel=team`, send a text frame, see it hit Hive's team handler.
- Kill Beekeeper, restart it, verify Hive re-registers within 30s.

### 7. Quality gate + PR

`npm run check` (typecheck + lint + format + test), then `dodi-dev:review`, then `dodi-dev:submit`.

## Out of scope (Phase B, separate ticket after cloudflared flip)

- Delete `src/beekeeper/`
- Delete `src/channels/ws/device-registry.ts` + `devices` Mongo collection + `/devices` admin endpoints
- Delete `/pair` from `ws-adapter.ts`
- Rebind WS adapter to `127.0.0.1` only
- Delete `WS_ADMIN_SECRET`, JWT signing, pairing code generation
- LaunchAgent changes

## Risks

- **`remoteAddress` format.** Node reports IPv4-mapped IPv6 as `::ffff:127.0.0.1` when the server listens on `::`. Handled in the loopback allowlist. Verified behavior matches Node ≥ 18.
- **Register loop runs before Beekeeper is up on first deploy.** Expected — it'll log warnings for up to 30s until Beekeeper comes online. That's the whole point of the 30s retry.
- **Synthetic `Device` shape.** The `Device` type has more fields than we populate. Using `as Device` on a minimal object is pragmatic for Phase A and disappears in Phase B when the legacy type goes away.
