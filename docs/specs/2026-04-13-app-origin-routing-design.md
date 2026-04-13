# App Origin Routing — Design

**Date:** 2026-04-13
**Status:** Draft (rev 3)
**Context:** dodi-shop-ios (and future single-purpose apps like a designer tool) need to land on a specific agent without the user picking one. Current `"app"` branch in ws-adapter drops messages because `defaultAgentId` was blanked in Phase B — not because `targetAgentId` is "always present" on team traffic (that claim in the line-135 comment is incorrect; the app branch was just never expected to carry real traffic again).

## Goal

A single-purpose app declares **what it is** once, on connect. Hive routes all its traffic to the agent that owns that app. Ownership lives on the agent definition so it hot-reloads like everything else.

## Non-goals

- Multi-agent threads from single-purpose apps (they're single-purpose by definition).
- Dynamic per-message routing — the app's identity is fixed at build time.
- Retiring the team protocol for keepur-ios. Keepur-ios keeps its multi-channel DM model.
- Indexing existing channel/name lookups. We add an index for origin only because it's a new hot-path; existing linear scans stay as-is.

## Protocol

There are **two URLs** in the connection chain. Both need to carry `origin`:

1. **Client → Beekeeper** (public, over Cloudflare Tunnel):
   ```
   wss://beekeeper.dodihome.com?token=...&channel=team&origin=dodi-shop
   ```
2. **Beekeeper → Hive** (loopback, inside the team proxy):
   ```
   ws://127.0.0.1:3200?internal=1&deviceId=...&name=...&origin=dodi-shop
   ```

Beekeeper is the translator between them: it reads `origin` off the client URL at upgrade time and appends it to the upstream URL it constructs in `proxyTeamConnection`. If the client didn't send one, beekeeper doesn't add one and hive falls back to existing routing.

### Message envelope: unchanged

Shop app keeps sending plain `{type:"message", text, id}`. No channelId, no agent picker, no team protocol migration. Origin is a **connection-level** tag — set once at upgrade, inherited by every message on that connection. Images (`type:"image"`) and any future file uploads on the app path inherit it the same way.

## Agent definition: `catches`

Extend the agent document in `agent_definitions`:

```ts
catches?: string[]   // origin slugs this agent owns
```

This field needs to be added in three places:
- `AgentDefinition` type (MongoDB shape)
- `AgentConfig` type at `src/types/agent-config.ts`
- `toAgentConfig` transform (wherever `AgentDefinition → AgentConfig` happens)

Existing docs without the field behave as `catches: []` — this is a silent no-op until seeds are re-imported, so **no migration needed**.

Example — production-support seed (Sige):
```yaml
_id: production-support
catches: ["dodi-shop"]
```

(Sige is the display name; `production-support` is the actual agent `_id` the routing table will hold.)

## Registry index

`agent-registry.ts` grows a new member:

```ts
private originToAgent: Map<string, string> = new Map();
```

Rebuilt every time `load()` runs (initial boot + SIGUSR1 reloads). To keep conflict resolution deterministic regardless of MongoDB's natural iteration order, we sort agents by `_id` before populating the index:

```ts
const sorted = [...this.agents.values()].sort((a, b) => a.id.localeCompare(b.id));
for (const agent of sorted) {
  for (const slug of agent.catches ?? []) {
    if (this.originToAgent.has(slug)) {
      log.error("Origin conflict — first sorted agent wins", {
        origin: slug,
        winner: this.originToAgent.get(slug),
        loser: agent.id,
      });
      continue;
    }
    this.originToAgent.set(slug, agent.id);
  }
}
```

Note: this is a divergence from the existing channel/name/keyword finders, which do linear scans via `getAll()`. We're adding an index only for origin because it sits on the hot dispatch path for every message from a single-purpose app. Existing linear-scan finders are not changing.

New public method, matching the return shape of `findByChannel`:

```ts
findByOrigin(slug: string): AgentConfig | undefined {
  const agentId = this.originToAgent.get(slug);
  return agentId ? this.agents.get(agentId) : undefined;
}
```

**Index rebuild placement in `load()`:** the index must be built **after** the full agent reconciliation (after the add/remove/update loop completes, not mid-loop), so removals clear stale entries and additions land cleanly. A simple `this.rebuildOriginIndex()` call at the end of `load()` keeps it obvious.

## Routing order in `resolveAgents`

Insert origin lookup **after** team routing, not before — keepur-ios sends `?origin=keepur` at the connection level for observability, but its actual routing is a team DM; origin must lose to an explicit team channelId or we'd break keepur-ios's multi-agent DM model.

```
0.   meta.targetAgentId         (explicit callbacks — unchanged)
0.5  source.kind === "team"     (team DMs/channels — unchanged)
0.6  meta.origin → catches      (NEW — single-purpose apps)
1.   channel mapping            (unchanged)
2.   thread continuity          (unchanged)
3.   name addressing            (unchanged)
4.   adapter defaultAgentId     (unchanged — still used by legacy paths)
```

Critical invariants:
- The origin step must `return` as soon as it finds a match, just like every other step, so thread continuity (step 2) never runs. This matters because the shop app uses `threadId: "app:${deviceId}"` — without the early return, a device that ever accidentally landed on a different agent would stay pinned to it via the persisted-session path at step 2c.
- Unknown origin (set but not in the index) drops with `log.warn("Origin not routed", {origin, deviceId})`. No fallback.
- If origin is set **and** there's an explicit `targetAgentId` (callback routing), targetAgentId wins — callbacks are explicit and intentional.

Triage still runs (keeps the "On it…" ack feel). No change there.

## Plumbing

### 1. dodi-shop-ios

`WebSocketManager.swift`: add `origin = "dodi-shop"` constant, append `&origin=\(origin)` to the URL. One-line change.

### 2. beekeeper team proxy

Three surfaces change — function signature, call site, and the emit/on-connection plumbing. The function alone is not enough.

**`src/index.ts` upgrade handler:**
- Parse `origin` alongside the existing `channel` check at line 492: `const origin = url.searchParams.get("origin") ?? undefined;`
- At the `wss.emit("connection", ...)` site (line 508), add `origin` as a fourth positional arg: `wss.emit("connection", ws, device, channel, origin)`.
- The `wss.on("connection", ...)` handler (line 519) grows a fourth parameter `origin?: string` and forwards it to `proxyTeamConnection` via the options bag (see below).

**`src/team-proxy.ts` `proxyTeamConnection`:**
- Function signature is at line 43. Do **not** add `origin` as a new positional parameter — extend the existing `ProxyTeamConnectionOptions` interface (options bag at line 18) with `origin?: string`. This keeps the call shape stable and gives every future proxy knob the same pattern.
- In the URL construction block (lines 56-62), append `&origin=${encodeURIComponent(options.origin)}` only when `options?.origin` is set. When absent, the upstream URL is byte-identical to today.
- Call site at `index.ts:556`: update from `proxyTeamConnection(ws, device, hiveEntry)` to `proxyTeamConnection(ws, device, hiveEntry, { origin })`.

**Test:** `src/team-proxy.test.ts` gets a new case constructing a proxy with `{ origin: "dodi-shop" }` and asserting the upstream URL contains `&origin=dodi-shop`. A second case with no options asserts byte-identical output vs. today.

### 3. hive ws-adapter

Three touches in `src/channels/ws/ws-adapter.ts`:

- **Device interface (lines 35-39):** extend with `origin?: string`. No other consumer of `Device` reads this field, so nothing ripples.
- **Upgrade handler (lines 100-140):** read `url.searchParams.get("origin") ?? undefined` and store on the synthetic Device built at line 137.
- **Comment at lines 134-136:** delete or rewrite. The existing comment says "Beekeeper only proxies channel=team traffic, which always carries targetAgentId on the wire" — that's wrong (team non-DM messages don't carry targetAgentId; they route via channel membership in `resolveFromTeam`) and it actively misleads anyone reading this branch. Replace with a short note that the app branch now carries routing via `meta.origin` instead of `defaultAgentId`.
- **Message branch (line 225, `type === "message"`):** add `origin: device.origin` to `workItem.meta`.
- **Image branch (line 250, `type === "image"`):** same — add `origin: device.origin` to `workItem.meta`. This was missing from rev 1 and would silently break photo uploads from the shop floor.

Team-message branches (lines 459, 519, 587) **do not** need origin — team traffic routes via `source.kind === "team"` at dispatcher step 0.5, which wins before origin is consulted. Rev 1's "belt and suspenders" line was wrong.

**Pre-existing bug, fixed in this PR:** `onProcessingStart` (lines 353-364) sends `agentId: device.defaultAgentId` for the typing indicator. Since Phase B set `defaultAgentId: ""`, it's been firing with an empty agentId on the app path — invisible until now because no messages routed, but user-visible on day one of origin routing.

**Fix:** guard `onProcessingStart` with `if (item.source.kind === "app") return;` — the "typing" frame was designed for the team path where the agent is known upfront via targetAgentId. On the app path the agent isn't known until `resolveAgents` runs, and we don't want to block the pipeline threading the resolved agent back through the adapter interface just for a typing indicator. Triage's "On it..." ack already handles the latency feel.

### 4. hive dispatcher

`src/channels/dispatcher.ts` `resolveAgents` (line 329+):
- Read `const origin = item.meta?.origin as string | undefined`.
- If set, look up via `this.registry.findByOrigin(origin)`.
  - **Match →** return `[{ agentId: match.id, skipTriage: false }]` with an early return. Thread continuity (step 2) must not run.
  - **No match →** `log.warn("Origin not routed", { origin, deviceId, text: item.text.slice(0, 50) })` and return `[]` (hard drop). Falling through to name-addressing could land a shop message on a random agent whose name appeared in the text ("can Jasper confirm the spec") — worse than dropping.

### 5. hive agent registry

- Add `catches?: string[]` to `AgentConfig`.
- Add the same to whichever type represents the MongoDB doc (`AgentDefinition` or similar — locate during implementation).
- Update `toAgentConfig` transform to pass the field through.
- Build `originToAgent` index on `load()` with sorted iteration + conflict logging as shown above.
- Expose `findByOrigin(slug)`.

### 6. Production-support agent def

Add `catches: ["dodi-shop"]` to `plugins/dodi/agent-seeds/production-support.yaml`, run `npm run setup:seeds` to re-import.

## Partial rollout / deployment window

Hive (steps 3–5) and beekeeper (step 2) ship as **one coordinated release**. The dodi-shop-ios change (step 1) ships after, via TestFlight.

Interim states during rollout:

| Hive has origin routing | Beekeeper forwards origin | Shop app sends origin | Behavior |
|---|---|---|---|
| no  | no  | no  | Status quo: dropped with "No agent found" (the current bug). |
| yes | no  | yes | Beekeeper strips the param → hive still drops. Same as today. **Safe.** |
| yes | yes | no  | Old shop app build: still drops with "No agent found". Same as today. **Safe.** |
| yes | yes | yes | Works end-to-end. |

No crash paths, no worse-than-today states. Hive + beekeeper can ship before the iOS release lands.

## Observability

- Origin shows up in every `workItem.meta` log line that already logs meta.
- `findByOrigin` miss logs once per message with `log.warn("Origin not routed", { origin, deviceId, text: preview })`.
- Registry conflict at load time logs once per conflict with `log.error("Origin conflict", ...)`.
- Not adding rate-limiting-by-origin in this spec — premature until we see abuse.

## Test plan

Concrete tests, not vague "integration":

**Unit — registry (`agent-registry.test.ts`):**
- Load two agents, one with `catches: ["foo"]` → `findByOrigin("foo")` returns it.
- Load two agents both with `catches: ["foo"]` → first sorted by id wins, error logged.
- `findByOrigin("unknown")` returns undefined.
- SIGUSR1 reload picks up added/removed `catches` entries.

**Unit — dispatcher (`dispatcher.test.ts`):**
- WorkItem with `meta.origin = "dodi-shop"` → routes to catching agent, skips thread affinity.
- WorkItem with `meta.origin = "unknown"` → returns empty, "No agent found" log.
- WorkItem with both `meta.origin` AND `meta.targetAgentId` → targetAgentId wins.
- Team WorkItem with channelId AND `meta.origin` → team routing wins (origin is ignored).

**Unit — ws-adapter (`ws-adapter.test.ts`):**
- Upgrade with `?origin=dodi-shop` → `Device.origin` is set.
- `type:"message"` on app-source connection → WorkItem.meta.origin matches.
- `type:"image"` on app-source connection → WorkItem.meta.origin matches.

**Unit — beekeeper (`team-proxy.test.ts`):**
- `proxyTeamConnection` with `origin: "dodi-shop"` → upstream URL includes `&origin=dodi-shop`.
- `proxyTeamConnection` with no origin → upstream URL unchanged.

**Manual end-to-end:**
- Shop phone sends "test message" → lands in production-support (Sige), appears in #agent-sige audit, response round-trips back to the app.
- Photo from shop phone → same, with image processing.

## Sequencing

1. Hive: add `catches` field to AgentConfig + AgentDefinition + toAgentConfig transform.
2. Hive: registry `originToAgent` index + `findByOrigin`.
3. Hive: dispatcher origin lookup (step 0.6).
4. Hive: ws-adapter reads origin query, sets on Device, populates meta for message + image branches.
5. Hive: fix `onProcessingStart` typing-indicator bug (same PR) — guard on `item.source.kind === "app"`.
6. Beekeeper: upgrade handler + `proxyTeamConnection` + test. Bump @keepur/beekeeper, redeploy.
7. Production-support seed: add `catches: ["dodi-shop"]`, run `npm run setup:seeds`.
8. dodi-shop-ios: append `&origin=dodi-shop` to WS URL. Ship to TestFlight.
9. Verify end-to-end on a shop-floor phone.

Steps 1–7 land together as a hive PR + a beekeeper release. Step 8 is an iOS release. Safe during the window per the rollout table above.
