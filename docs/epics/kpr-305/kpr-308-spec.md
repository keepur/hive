# KPR-308 — W2.3: LAN-direct WebSocket path for the iOS app

**Status:** DRAFT — decision-ready, awaiting human ruling on the D3 option pick (§4)
**Epic:** KPR-305 · **Baseline:** `keepur/hive` @ `08ca29e` (branch `kpr-305`) · sibling survey: `~/github/beekeeper` local checkout (read-only)
**Ticket text:** "WS channel reachable on-LAN without cloudflared (static host or discovery config); outage-mode routing prefers the LAN channel for floor-critical agents. Today shop.dodihome.com rides the tunnel and dies with the WAN."

---

## TL;DR

The iOS app reaches hive's WS channel only through cloudflared → beekeeper (public :8420) → loopback proxy → hive (`127.0.0.1:3200`). When the WAN dies, the tunnel dies, and the shop floor loses its agents even though the Mac mini is ten feet away on the same LAN. Code survey shows the fix is much smaller than the ticket implies: **beekeeper already listens on all interfaces** (`server.listen(config.port)` with no host argument — `beekeeper/src/index.ts:1037`) **and its JWT device auth is transport-independent** (`device-registry.ts:341`). A LAN client that connects to `ws://<mini-hostname>.local:8420/?token=<jwt>&channel=hive` today gets the same authenticated, proxied session as one arriving via cloudflared — no tunnel in the path. **Recommendation: Option (b)** — treat LAN exposure as beekeeper's job (mostly already done; the remaining items are a small interface contract), keep hive's slice to the **outage-mode routing preference** (dispatcher prefers the app channel for floor-critical agents when KPR-306's breaker is open), and have the iOS app carry an ordered endpoint list with failover. Option (a) — a hive-owned LAN listener with its own auth — would reverse the Phase-B architecture decision that moved all device identity out of hive, and is scoped here only as a decision record.

## Key Points

- **Verified:** hive's ws-adapter binds `127.0.0.1` only (`src/channels/ws/ws-adapter.ts:337`) and trusts `?internal=1` loopback traffic, reading `deviceId`/`label`/`user` off query params (`:133-166`). All external auth (pairing, JWT, device registry) lives in beekeeper (`ws-adapter.ts:29-37` doc comment; beekeeper `device-registry.ts`, `team-proxy.ts:47-51` URL contract). cloudflared config is not in this repo (`docs/architecture.md:121` defers to beekeeper's federation doc).
- **Verified:** beekeeper's public server is plain `node:http` (no TLS — cloudflared terminates TLS today) and listens on **all interfaces** (`index.ts:108`, `:1037`). JWT verification uses a shared secret + SQLite device/user active checks with no dependence on Host, origin, or peer address (`device-registry.ts:341-369`). ⚠ **Assumption:** nothing at the deployed-host level (macOS application firewall, pf rules) blocks LAN clients from :8420 — unverified against the production mini; must be checked during rollout.
- **Verified:** the dispatcher keys adapters by `adapter.id` (`src/channels/dispatcher.ts:44`, `:80-82`) and picks the delivery adapter from the WorkItem source: `this.adapters.get(item.source.adapterId ?? item.source.kind)` (`:116`, `:200`, `:597`). There is **no per-agent channel-preference concept** anywhere in the dispatcher today. Scheduled turns are synthesized with `source: { kind: "slack", id: homeChannel }` (`src/scheduler/scheduler.ts:233`), so during a WAN outage a floor-critical agent's scheduled output is aimed at a dead Slack socket.
- **Inbound-over-LAN already round-trips with zero routing change**: a WS-sourced WorkItem's reply is delivered back through the ws adapter because delivery is source-keyed. The routing slice in this ticket only affects **agent-initiated traffic** (scheduler, callbacks, event-bus turns) whose synthesized source points at Slack.
- The routing slice binds to **the breaker-state surface KPR-306's spec exports** (drafted in parallel). This spec does not define that API; it isolates the dependency behind a one-function seam (§5.3) so either spec can land first.
- **iOS app changes are external to this repo.** §6 names the app-side contract (ordered endpoint list + failover + same JWT); implementation belongs to the app's owner.
- ⚠ **Assumption:** plain `ws://` on the shop LAN is acceptable for W2 (JWT still gates access, but frames are cleartext on the local network, and a captured token could be replayed by a LAN attacker). The TLS-on-LAN upgrade path is named in §7 but deferred.
- ⚠ **Assumption:** `.local` mDNS hostname resolution works on the shop Wi-Fi (same subnet, multicast not filtered). If the shop AP isolates clients or blocks mDNS, the fallback is a static LAN IP/DHCP reservation typed into the app — the contract in §6 supports both.

---

## 1. Problem

`shop.dodihome.com` → cloudflared tunnel → beekeeper `:8420` → (loopback proxy, `?channel=hive`) → hive ws-adapter `127.0.0.1:3200`. Every hop after cloudflared is on-box; the only WAN-dependent hop is the first one. A WAN outage therefore takes down the entire app channel while hive, beekeeper, MongoDB, and the LAN are all healthy. Two distinct gaps:

1. **Transport:** the app has no LAN endpoint to fail over to.
2. **Routing:** even with LAN transport, agent-initiated output (scheduled tasks, callbacks) is synthesized with a Slack source and will be delivered into a dead Slack socket during the outage instead of reaching the floor device.

## 2. Verified baseline (code trace @ 08ca29e)

| Fact | Evidence |
|---|---|
| Hive WS adapter binds loopback only | `src/channels/ws/ws-adapter.ts:337` — `this.server.listen(this.port, "127.0.0.1", ...)` |
| Upgrade path trusts loopback + query params; rejects non-`internal=1` and non-loopback peers | `ws-adapter.ts:124-170` |
| Device identity is synthetic; hive owns no device registry post-Phase-B | `ws-adapter.ts:29-44` |
| Hive advertises itself to beekeeper every 30s (`/internal/register-capability`, loopback) | `src/beekeeper-client.ts` (whole file); gated on `ws.enabled` at `src/index.ts:671-674` |
| `ws.enabled` defaults **false**; port from `WS_PORT`/`ports.ws` | `src/config.ts:273-276` |
| Dispatcher: adapters in a `Map` keyed by `adapter.id`; delivery adapter = `source.adapterId ?? source.kind` | `dispatcher.ts:44`, `:80-82`, `:200` |
| Scheduler synthesizes `source: { kind: "slack", id: homeChannel }` | `scheduler/scheduler.ts:220-239` |
| WS delivery requires `meta.deviceId`; buffers for reconnect if the device is offline | `ws-adapter.ts:344-393` |
| Beekeeper listens on **all interfaces**, plain HTTP | `beekeeper/src/index.ts:108`, `:1037` (`server.listen(config.port)`, no host) |
| Beekeeper JWT auth is transport-independent (`?token=` or `Authorization` header) | `beekeeper/src/index.ts:571-572`, `device-registry.ts:341-369` |
| Proxy URL contract to hive: `?internal=1&deviceId=…&label=…&user=…[&origin=…]` | `beekeeper/src/team-proxy.ts:47-51`, `:66-78` |
| cloudflared is ops config, not code, in either repo; flip history in beekeeper spec | `beekeeper/docs/specs/2026-04-12-pair-gateway-and-hive-federation.md:189-204` |

## 3. Non-goals

- No change to Slack, SMS, voice, or scheduler channels beyond the delivery-preference hook.
- No offline/degraded *model* story — if Anthropic API access also requires WAN, agents cannot run at all; that is outside this ticket. This ticket restores the **channel**, so it pays off fully only alongside whatever WAN-redundancy or degraded-mode work the epic carries elsewhere. ⚠ Worth confirming at Gate: is the outage scenario "ISP down, cellular-backup WAN for API calls" (routing slice valuable) or "total air gap" (channel works, agents can't think)?
- No publish of hive's own port to the LAN under the recommendation (option b keeps `127.0.0.1` binding — the Phase-B trust model stands).
- No iOS implementation (external; contract only, §6).

---

## 4. D3 — Architecture options (the blocking decision)

### Option (a) — hive-side LAN listener with self-contained auth

Hive grows a second WS listener bound to the LAN interface, plus everything the loopback-trust model currently outsources:

- **Auth model:** hive would need its own device identity. Choices within the option: (i) reintroduce a device registry + pairing + JWT — a re-implementation of exactly what Phase-B deleted from hive and moved to beekeeper (`ws-adapter.ts:29-37`); (ii) a pre-shared key in `hive.yaml` — weakest, one shared secret for all devices, no revocation granularity, and a new secret that must live outside Honeypot's curated flow or be added to it; (iii) mTLS — strongest, but certificate provisioning onto iOS devices (profiles/MDM) is heavy operational machinery for a single-shop deployment.
- **TLS posture:** hive currently has zero TLS anywhere; it would either terminate TLS itself (cert management in the engine) or run plain `ws://` (same cleartext caveat as option b, minus beekeeper's existing auth maturity).
- **Config surface:** `ws.lanBind` / `ws.lanPort`, secret registration in the credentials registry, doctor section for the new listener.
- **Real size:** new listener + auth subsystem + pairing CLI/flow + token issue/verify + revocation + tests + doctor surface ≈ **10-15 files, 1,500-2,500 LOC, weeks not days** — and it *duplicates* a live, tested subsystem in beekeeper (device-registry.ts is 421 lines by itself, before pairing endpoints and CLI).
- **Architecture cost:** reverses the Phase-B decision ("Hive's WS adapter no longer owns a device registry — `@keepur/beekeeper` does"). Two device registries, two pairing flows, two JWT secrets to rotate. The security posture doc (DOD-212) pushes hard against exactly this kind of ad-hoc second path.

**Verdict:** technically self-sufficient (no cross-repo dependency), but the most expensive option by an order of magnitude and an architectural regression. Keep as decision record only.

### Option (b) — beekeeper-side LAN exposure; hive keeps only the routing slice ← **recommended**

The survey finding that reshapes this ticket: **beekeeper's public port is already LAN-reachable and its auth already works there.** `server.listen(config.port)` binds all interfaces; `verifyToken` doesn't care how the packet arrived; the `?channel=hive` proxy to hive's loopback adapter is transport-agnostic. A paired iOS device pointing at `ws://<mini>.local:8420/?token=<jwt>&channel=hive` gets a fully authenticated session today, tunnel down or not.

**Beekeeper interface contract** (named here as a contract, since that repo is out of scope for this ticket; items verified against the local checkout except where flagged):

| # | Contract item | Status |
|---|---|---|
| B-1 | Public server accepts connections on LAN interfaces (not just via tunnel) with identical JWT auth and `?channel=hive` proxying | **Already true** at `beekeeper/src/index.ts:1037` — no code change. Optionally beekeeper adds an explicit `bind:` config key to make the posture deliberate rather than incidental. |
| B-2 | Auth (JWT verify, device active-check, revocation) behaves identically for LAN-originated connections | **Already true** — `device-registry.ts:341-369` is transport-independent. |
| B-3 | *(Optional, non-blocking)* `POST /pair` response and/or `GET /capabilities` advertises the LAN endpoint (e.g. `lanEndpoints: ["ws://<hostname>.local:8420"]`) so the app auto-learns it at pair time instead of manual entry | **Not implemented** — small additive change in beekeeper; the W2 path works without it via manual endpoint entry in the app. |
| B-4 | *(Deferred)* Optional TLS on the LAN listener (self-signed/mkcert, cert pinned in app) | **Not implemented**; see §7. W2 accepts plain `ws://` on LAN. |
| B-5 | ⚠ Ops: confirm macOS firewall/pf on the production mini permits inbound :8420 from the LAN subnet | **Unverified** — rollout checklist item, not code. |

**Hive changes under (b):** the outage-mode routing preference slice only (§5). Hive's ws-adapter, loopback binding, and trust model are untouched.

**Real size (hive):** ~4-6 files, ~200-400 LOC including tests. Days, not weeks.

### Option (c) — defer the transport, ship only the routing-preference slice in W2

Build §5 (floor-critical designation + dispatcher preference behind the KPR-306 seam) and stop. **The catch:** without a LAN-reachable transport, the app channel dies with the WAN too — the routing preference would fire and find zero connected devices, fall through to the (dead) Slack path, and deliver nothing. The slice is inert until a transport exists. (c) only makes sense if the operator wants to decouple the hive PR from the beekeeper/app coordination and accept that W2 delivers no actual outage capability. Given that option (b)'s beekeeper-side cost is ~zero mandatory code, (c) buys almost nothing over (b).

### Recommendation

**Option (b).** The expensive parts of "LAN-direct" turn out to already exist in beekeeper; hive's slice shrinks to the routing preference, which is also the only part that binds to KPR-306. The beekeeper contract is two already-true facts plus two optional follow-ups. The decision the operator actually needs to make is the **acceptance of plain `ws://` on the shop LAN for W2** (§7) and confirmation of the option pick.

---

## 5. Hive design — outage-mode routing preference (the (b)/(c) slice)

### 5.1 Floor-critical designation

New optional boolean on the agent definition: **`floorCritical`** (default `false`).

- `src/types/agent-definition.ts` — add `floorCritical: boolean` to the interface; `fromDoc` parses `doc.floorCritical ?? false` (liberal-loader pattern, same as existing optional fields around `:127`).
- Admin MCP `agent_create` / `agent_update` accept and persist it (plain boolean, no cross-field constraints — nothing like the KPR-184 `delegateServers` rules applies).
- Surfaced in the WS `agent_list` payload (`ws-adapter.ts:buildAgentList`) so the app can badge floor-critical agents. *(Nice-to-have; drop if it bloats the PR.)*

Rejected alternative: a richer `outageRouting: { preferChannel: "app" }` object. YAGNI — there is exactly one alternate channel today; a boolean names the business concept ("this agent must stay reachable on the floor") rather than the mechanism.

### 5.2 Dispatcher delivery preference

At the two delivery sites (`dispatcher.ts:200` and `:597`), before resolving the adapter from the source, apply one guard:

```
if (outage-mode is active
    && agent.floorCritical
    && wsAdapter is registered
    && wsAdapter.connectionCount > 0
    && item.source.kind is "slack" or "scheduler")   // never divert app/team/sms-sourced replies
  → deliver via the ws adapter (broadcast, §5.4) instead of the source adapter
  → on broadcast failure, fall through to the normal source-adapter path (existing retry queue semantics unchanged)
```

Source-keyed replies for app/team-originated items are untouched — they already route correctly. SMS is deliberately excluded from diversion: an SMS user is not on the shop floor.

### 5.3 Breaker dependency seam (KPR-306)

The dispatcher must not import KPR-306's implementation. Add:

```ts
type OutageStateProvider = () => boolean; // true = outage mode active
dispatcher.setOutageStateProvider(fn)
```

`src/index.ts` wires `fn` to **the breaker-state surface KPR-306's spec exports**, in whatever shape that spec lands (sync getter, cached snapshot — the seam absorbs it). Until KPR-306 merges, the provider defaults to `() => false` and the whole slice is dormant. This keeps the two specs decoupled and lets either PR land first.

### 5.4 WS broadcast delivery

`WsAdapter.deliver()` requires `meta.deviceId` (`ws-adapter.ts:345-349`); a diverted scheduler/Slack item has none. Add:

```ts
async deliverBroadcast(result: WorkResult): Promise<number> // returns delivered-connection count
```

- Sends the standard `message` frame (agent id/name resolved as in `deliver()`) to **every currently open connection**.
- **No offline buffering** for broadcasts (unlike `deliver()`'s pendingMessages path) — an outage notice queued for a device that reconnects next week is noise, and the dispatcher's fall-through already covers the zero-connections case.
- Returns the count so the dispatcher can treat `0` as "not delivered" and fall through.

Rejected alternative: a configured "floor device id" in `hive.yaml`. Devices are beekeeper-owned and hive sees only synthetic per-connection identities; pinning one id in hive config crosses the ownership boundary and breaks when the device re-pairs. Whoever is connected on the LAN during an outage *is* the floor.

### 5.5 Config surface

None required in `hive.yaml` for the slice. The per-agent `floorCritical` flag is the only knob; the breaker seam is wired in code. (If KPR-306's spec introduces an outage-mode master switch, this slice inherits it through the provider — nothing to add here.)

### 5.6 Observability

- `createLogger("dispatcher")` info-line on each diversion: agent id, source kind, delivered-connection count. No message text (log-redaction convention).
- *(Optional)* `hive doctor` line under the existing channel section: count of floor-critical agents + whether an outage provider is wired. Drop if KPR-306 already surfaces breaker state in doctor.

### 5.7 Testing contract

- `agent-definition` parse: `floorCritical` absent/true/false/garbage → boolean, default false.
- Dispatcher matrix (unit, fake adapters): breaker open/closed × floorCritical true/false × ws connections 0/n × source kind slack/scheduler/app — diversion fires only on the one correct cell per rule; app-sourced replies never divert; zero-connection broadcast falls through to source adapter.
- `WsAdapter.deliverBroadcast`: n open connections all receive the frame; closed sockets skipped; returns accurate count; does **not** touch `pendingMessages`.
- Admin MCP: `agent_update` round-trips `floorCritical`.

## 6. iOS app contract (external — named, not implemented here)

Owner: the iOS app repo (outside `keepur/hive` and `keepur/beekeeper`). The app must:

1. Hold an **ordered endpoint list**: `[wss://shop.dodihome.com, ws://<endpoint-2>]` where endpoint 2 is the LAN endpoint.
2. **Failover:** on connect failure/close of endpoint 1, try endpoint 2 (and back — prefer the tunnel when it returns, since it carries TLS).
3. Use the **same device JWT** on both endpoints (verified transport-independent, §2).
4. Carry the ATS exception for local networking (`NSAllowsLocalNetworking`) so plain `ws://` to a LAN host is permitted — required only until B-4 (TLS on LAN) ships.
5. **Endpoint acquisition — static host recommended:** default the LAN endpoint to `ws://<mini-hostname>.local:8420` (mDNS hostname resolution is native on iOS; zero server-side work), editable in app settings as an escape hatch (static IP/DHCP reservation for mDNS-hostile networks — ⚠ see Key Points). Full Bonjour *service* discovery (beekeeper advertising `_beekeeper._tcp` + app `NWBrowser`) is the heavyweight alternative; it needs new code on both sides and buys little over `.local` in a one-mini shop — **defer**, revisit only if multi-site or DHCP churn makes static hosts painful. If beekeeper ships B-3, the app auto-fills the LAN endpoint at pair time.

## 7. Security posture

- **Auth on LAN = unchanged beekeeper JWT** (per-device, revocable, active-checked per upgrade). No new credential, nothing added to Honeypot, no agent-visible secret — consistent with DOD-212.
- **Hive's trust boundary is unchanged** under option (b): ws-adapter stays loopback-bound; only beekeeper faces the LAN, which is already its job description.
- ⚠ **Cleartext on LAN (W2 accepted risk, needs operator sign-off):** plain `ws://` means message frames and the query-string JWT are readable/replayable by anyone on the shop network. Mitigations now: shop Wi-Fi is WPA2/3 (link-layer encryption from clients to AP), device revocation via beekeeper. Upgrade path: B-4 — beekeeper optional TLS with an mkcert/self-signed cert pinned in the app; tracked as a beekeeper follow-up ticket, not W2.
- The tunnel path remains preferred when healthy (app-side ordering, §6.2), so cleartext exposure is limited to actual outage windows plus any manual LAN use.

## 8. Scope summary

| Piece | Repo | Size | When |
|---|---|---|---|
| `floorCritical` field + parse + admin passthrough | hive | S | W2 |
| Dispatcher outage preference + breaker seam | hive | S-M | W2 (dormant until KPR-306 wires the provider) |
| `WsAdapter.deliverBroadcast` | hive | S | W2 |
| Tests (§5.7) | hive | M | W2 |
| B-1/B-2 (LAN reachability + auth) | beekeeper | **0** (verify only) | now |
| B-3 pair-time LAN-endpoint advertisement | beekeeper | S | optional, post-W2 |
| B-4 TLS on LAN | beekeeper + app | M | deferred |
| Endpoint list + failover + ATS exception | iOS app | M | external, parallel |
| Firewall/pf check on production mini (B-5) | ops | — | rollout checklist |

## 9. Open questions

1. **[BLOCKING — the D3 ruling]** Option pick: (a) hive-owned LAN listener, **(b) beekeeper-side exposure + hive routing slice (recommended)**, or (c) routing slice only. Includes accepting plain `ws://` on the shop LAN for W2 (§7).
2. **[Non-blocking]** Does the outage scenario include API-path redundancy (cellular backup WAN)? If the whole site is air-gapped when the WAN dies, agents can't call Anthropic and the routing slice restores an empty channel (§3). Doesn't change this design; changes how much W2 celebrates.
3. **[Non-blocking]** Should B-3 (pair-time LAN endpoint advertisement) be filed as a beekeeper ticket now so the app never needs manual endpoint entry?
4. **[Non-blocking]** `agent_list` exposure of `floorCritical` to the app (§5.1) — include in W2 or trim?
