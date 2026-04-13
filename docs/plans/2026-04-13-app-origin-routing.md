# App Origin Routing Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Let single-purpose apps declare what they are at connect time (`?origin=dodi-shop`) and route all their traffic to the agent that owns that origin via a new `catches: string[]` field on agent definitions.

**Architecture:** Client iOS app sends `?origin=<slug>` on WS upgrade → beekeeper's team proxy forwards it on the upstream URL → hive's ws-adapter stashes on the Device record → dispatcher looks up via a new `originToAgent` registry index and pins the agent.

**Tech Stack:** TypeScript, Node 24, `ws` package, Vitest, MongoDB. Two repos: `~/github/hive` and `~/github/beekeeper` (npm package `@keepur/beekeeper`).

**Spec:** `docs/specs/2026-04-13-app-origin-routing-design.md`

**Plan rev:** 2 (first rev reviewed by feature-dev:code-architect 2026-04-13; test helper names and `setup-seeds.ts` passthrough fixed in this rev)

---

## File Structure

### Hive (`~/github/hive`)

| File | Responsibility |
|---|---|
| `src/types/agent-config.ts` | Add `catches?: string[]` to runtime agent config. |
| `src/types/agent-definition.ts` | Add `catches?: string[]` to DB shape; pass through in `toAgentConfig`. |
| `setup/setup-seeds.ts` | Pass `catches` from YAML into the inserted `AgentDefinition` doc (otherwise fresh installs would drop the field). |
| `src/agents/agent-registry.ts` | New `originToAgent` index, `rebuildOriginIndex()`, `findByOrigin()`. |
| `src/agents/agent-registry.test.ts` | Test index build, conflict logging, lookup. |
| `src/channels/dispatcher.ts` | Insert origin lookup step 0.6 in `resolveAgents`. |
| `src/channels/dispatcher.test.ts` | Test origin routing precedence + unknown-origin drop. |
| `src/channels/ws/ws-adapter.ts` | Extend `Device`, read origin query param, populate `meta.origin`, guard `onProcessingStart`, rewrite stale Phase B comment. |
| `src/channels/ws/ws-adapter.test.ts` | Test origin propagation from upgrade → WorkItem. |
| `plugins/dodi/agent-seeds/production-support.yaml` | Add `catches: ["dodi-shop"]`. |

### Beekeeper (`~/github/beekeeper`)

| File | Responsibility |
|---|---|
| `src/team-proxy.ts` | Add `origin?: string` to `ProxyTeamConnectionOptions`, append to upstream URL when set. |
| `src/team-proxy.test.ts` | Test URL is byte-identical when no origin; contains `&origin=...` when set. |
| `src/index.ts` | Parse `origin` in upgrade handler, emit as 4th arg, pass to `proxyTeamConnection` via options. |
| `package.json` | Bump patch version. |

### dodi-shop-ios (`~/github/dodi-shop-ios`) — follow-up, not in this plan

Single-line change to `WebSocketManager.swift` to append `&origin=dodi-shop`. Ships via TestFlight after hive + beekeeper are deployed. Tracked as follow-up.

---

## Sequencing

Two PRs land in this order:

1. **Beekeeper PR** (Tasks B1–B3) → merge → npm publish new version → deploy beekeeper service.
2. **Hive PR** (Tasks H1–H6) → merge → deploy hive service.

During the window after beekeeper ships but before hive ships, beekeeper forwards `origin` to hive but hive ignores it — safe, same as today. During the window after hive ships but before the iOS release, the app still doesn't send `origin` — safe, also same as today. See spec rollout table.

---

## Task B1: Beekeeper — team-proxy options + URL append

**Repo:** `~/github/beekeeper`

**Files:**
- Modify: `src/team-proxy.ts` (interface at line 18, URL block at lines 56-62)
- Test: `src/team-proxy.test.ts`

- [ ] **Step 1:** Extend `ProxyTeamConnectionOptions` with `origin?: string`.

In `src/team-proxy.ts`, replace the `ProxyTeamConnectionOptions` interface (lines 18-25):

```typescript
export interface ProxyTeamConnectionOptions {
  /** Backpressure threshold in bytes (default 4 MiB). */
  backpressureThresholdBytes?: number;
  /** Interval in ms for polling bufferedAmount when paused (default 50ms). */
  backpressureResumePollMs?: number;
  /** Upstream keepalive ping interval in ms (default 30_000). */
  upstreamPingIntervalMs?: number;
  /** Opaque app-identity slug forwarded to hive via the upstream URL. */
  origin?: string;
}
```

- [ ] **Step 2:** Conditionally append `&origin=...` to the upstream URL.

In the same file, replace the URL construction block (lines 56-62):

```typescript
  const base = hiveEntry.localWsUrl.replace(/\/+$/, "");
  let upstreamUrl =
    base +
    "/?internal=1&deviceId=" +
    encodeURIComponent(deviceId) +
    "&name=" +
    encodeURIComponent(deviceName);
  if (options.origin) {
    upstreamUrl += "&origin=" + encodeURIComponent(options.origin);
  }
```

- [ ] **Step 3:** Add tests.

Use the existing `startHive()` + `startClientAcceptor()` + `makeHiveEntry()` + `DEVICE` + `waitOpen` helpers at the top of `src/team-proxy.test.ts`. These already capture the upstream URL via `hive.lastInternalUrl`. Append to the existing `describe("proxyTeamConnection", …)` block (or add a sibling describe — match the file's style):

```typescript
  it("appends origin to upstream URL when options.origin is set", async () => {
    hive = await startHive();
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    proxyTeamConnection(serverClient, DEVICE, makeHiveEntry(hive.url), { origin: "dodi-shop" });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hive && hive.connections.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });

    expect(hive.lastInternalUrl).toContain("&origin=dodi-shop");
    outgoing.close();
  });

  it("omits origin from upstream URL when options.origin is unset", async () => {
    hive = await startHive();
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    proxyTeamConnection(serverClient, DEVICE, makeHiveEntry(hive.url));
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hive && hive.connections.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });

    expect(hive.lastInternalUrl).not.toContain("origin=");
    outgoing.close();
  });

  it("url-encodes origin values with special chars", async () => {
    hive = await startHive();
    acceptor = await startClientAcceptor();

    const clientSidePromise = acceptor.acceptNext();
    const outgoing = new WsWebSocket(acceptor.clientUrl);
    await waitOpen(outgoing);
    const serverClient = await clientSidePromise;

    proxyTeamConnection(serverClient, DEVICE, makeHiveEntry(hive.url), { origin: "weird slug/1" });
    await new Promise<void>((resolve) => {
      const t = setInterval(() => {
        if (hive && hive.connections.length > 0) {
          clearInterval(t);
          resolve();
        }
      }, 5);
    });

    expect(hive.lastInternalUrl).toContain("&origin=weird%20slug%2F1");
    outgoing.close();
  });
```

If the repetitive setup becomes tedious, factor a small `openProxied(options)` helper at the top of the new block — but don't touch the existing tests.

- [ ] **Step 4:** Run tests.

```bash
cd ~/github/beekeeper && npm test -- team-proxy
```

Expected: all existing tests still pass, three new `origin forwarding` tests pass.

- [ ] **Step 5:** Commit.

```bash
cd ~/github/beekeeper
git add src/team-proxy.ts src/team-proxy.test.ts
git commit -m "feat(team-proxy): forward origin query param to upstream URL"
```

---

## Task B2: Beekeeper — upgrade handler parses origin, passes through

**Repo:** `~/github/beekeeper`

**Files:**
- Modify: `src/index.ts` (upgrade handler around line 492, emit at line 508, on-connection at line 519, proxyTeamConnection call at line 556)

- [ ] **Step 1:** Parse `origin` in the upgrade handler.

In `src/index.ts`, find the block around line 492 (the `channel` parse). Add origin parsing right after:

```typescript
      // Parse channel query param — defaults to "beekeeper" for backwards compat.
      const channel = url.searchParams.get("channel") ?? "beekeeper";
      if (channel !== "beekeeper" && channel !== "team") {
        log.warn("WebSocket upgrade rejected — invalid channel", { channel });
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      // Parse origin query param — optional app-identity slug forwarded to hive.
      const origin = url.searchParams.get("origin") ?? undefined;
```

- [ ] **Step 2:** Pass `origin` through `wss.emit`.

In the same file, update line 508 from:

```typescript
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, device, channel);
      });
```

to:

```typescript
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, device, channel, origin);
      });
```

- [ ] **Step 3:** Receive `origin` in the `wss.on("connection")` handler.

Update line 519 from:

```typescript
  wss.on("connection", (ws: WebSocket, device: BeekeeperDevice, channel: "beekeeper" | "team" = "beekeeper") => {
```

to:

```typescript
  wss.on("connection", (
    ws: WebSocket,
    device: BeekeeperDevice,
    channel: "beekeeper" | "team" = "beekeeper",
    origin?: string,
  ) => {
```

- [ ] **Step 4:** Forward `origin` to `proxyTeamConnection` via the options bag.

Update line 556 from:

```typescript
        const handle = proxyTeamConnection(ws, device, hiveEntry);
```

to:

```typescript
        const handle = proxyTeamConnection(ws, device, hiveEntry, { origin });
```

- [ ] **Step 5:** Verify build.

```bash
cd ~/github/beekeeper && npm run build
```

Expected: clean build, no type errors.

- [ ] **Step 6:** Run full test suite.

```bash
cd ~/github/beekeeper && npm test
```

Expected: all tests pass.

- [ ] **Step 7:** Commit.

```bash
cd ~/github/beekeeper
git add src/index.ts
git commit -m "feat(beekeeper): parse origin on upgrade and forward to team proxy"
```

---

## Task B3: Beekeeper — quality gate, PR, publish

**Repo:** `~/github/beekeeper`

- [ ] **Step 1:** Full check.

```bash
cd ~/github/beekeeper && npm run check
```

Expected: typecheck + lint + format + test all pass.

- [ ] **Step 2:** Bump patch version.

```bash
cd ~/github/beekeeper && npm version patch --no-git-tag-version
```

- [ ] **Step 3:** Commit version bump.

```bash
git add package.json package-lock.json
git commit -m "chore: bump version for origin forwarding"
```

- [ ] **Step 4:** Push and open PR via `dodi-dev:submit` or `gh pr create`.

```bash
gh pr create --title "feat: forward origin query param through team proxy" --body "$(cat <<'EOF'
## Summary
- Parse `origin` query param on WS upgrade
- Forward via options bag to `proxyTeamConnection`
- Append to upstream URL so hive can read it

Hive side lands in a follow-up PR on keepur/hive.

Spec: hive docs/specs/2026-04-13-app-origin-routing-design.md

## Test plan
- [x] New tests in team-proxy.test.ts
- [x] npm run check passes
EOF
)"
```

- [ ] **Step 5:** After CI green + merge, publish to npm per the repo's release process.

---

## Task H1: Hive — add `catches` field to types + seed importer

**Repo:** `~/github/hive`

**Files:**
- Modify: `src/types/agent-config.ts`
- Modify: `src/types/agent-definition.ts`
- Modify: `setup/setup-seeds.ts` (otherwise fresh installs silently drop the YAML `catches` field)

- [ ] **Step 1:** Add `catches?: string[]` to `AgentConfig`.

In `src/types/agent-config.ts`, inside the `AgentConfig` interface (after line 14, the `homeBase` field):

```typescript
  homeBase?: string;
  catches?: string[]; // origin slugs this agent owns (e.g. ["dodi-shop"])
  passiveChannels: string[];
```

- [ ] **Step 2:** Add `catches?: string[]` to `AgentDefinition`.

In `src/types/agent-definition.ts`, inside the `AgentDefinition` interface in the Routing section (after `homeBase` at line 18):

```typescript
  homeBase?: string; // Primary channel for scheduler delivery; required at agent_create boundary
  catches?: string[]; // Origin slugs this agent owns — routes `?origin=<slug>` app traffic
  passiveChannels: string[];
```

- [ ] **Step 3:** Pass through in `toAgentConfig`.

In the same file, inside `toAgentConfig` (around line 87, next to `homeBase`):

```typescript
    homeBase: doc.homeBase,
    catches: doc.catches,
    passiveChannels: doc.passiveChannels ?? AGENT_DEFINITION_DEFAULTS.passiveChannels,
```

- [ ] **Step 4:** Pass `catches` through in `setup-seeds.ts`.

In `setup/setup-seeds.ts`, inside the `AgentDefinition` doc construction around line 54-82, add `catches` next to `channels` (between `icon` and `channels`, or wherever reads cleanest):

```typescript
      const doc: AgentDefinition = {
        _id: raw._id,
        name: raw.name ?? raw._id,
        model: raw.model ?? "claude-sonnet-4-6",
        icon: raw.icon ?? AGENT_DEFINITION_DEFAULTS.icon,
        channels: raw.channels ?? [],
        catches: raw.catches,
        passiveChannels: raw.passiveChannels ?? AGENT_DEFINITION_DEFAULTS.passiveChannels,
        // ...rest unchanged
```

Without this, fresh installs from seed YAML silently drop the `catches` field even after the type exists.

- [ ] **Step 5:** Verify typecheck.

```bash
cd ~/github/hive && npm run typecheck
```

Expected: clean.

- [ ] **Step 6:** Commit.

```bash
git add src/types/agent-config.ts src/types/agent-definition.ts setup/setup-seeds.ts
git commit -m "feat(types): add catches field to agent config, definition, and seed importer"
```

---

## Task H2: Hive — registry `originToAgent` index + `findByOrigin`

**Repo:** `~/github/hive`

**Files:**
- Modify: `src/agents/agent-registry.ts`
- Test: `src/agents/agent-registry.test.ts`

- [ ] **Step 1:** Add private index field.

In `src/agents/agent-registry.ts` around line 15 (inside the `AgentRegistry` class), after `private agents = new Map<string, AgentConfig>();`:

```typescript
  private agents = new Map<string, AgentConfig>();
  private originToAgent = new Map<string, string>();
  private disabledAgents: AgentConfig[] = [];
```

- [ ] **Step 2:** Add `rebuildOriginIndex` method.

Add this as a private method in the class (place it between `stopWatching` at line 149 and `get` at line 160):

```typescript
  private rebuildOriginIndex(): void {
    this.originToAgent.clear();
    // Sort by id so conflict resolution is deterministic regardless of Map iteration order.
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
  }
```

- [ ] **Step 3:** Call `rebuildOriginIndex` at the end of `load()`.

In `load()` (around line 109, after `this.lastPollTime = new Date();`), add the rebuild call:

```typescript
    this.lastPollTime = new Date();
    this.rebuildOriginIndex();
    return { added, updated, removed };
```

- [ ] **Step 4:** Add `findByOrigin` public method.

Add next to `findByChannel` (which lives at line 176):

```typescript
  findByChannel(channelName: string): AgentConfig | undefined {
    return this.getAll().find((a) => !a.disabled && a.channels.includes(channelName));
  }

  findByOrigin(slug: string): AgentConfig | undefined {
    const agentId = this.originToAgent.get(slug);
    return agentId ? this.agents.get(agentId) : undefined;
  }
```

- [ ] **Step 5:** Add tests.

Existing helpers in `src/agents/agent-registry.test.ts`:
- `makeDefinition(overrides)` at line 18 — builds an `AgentDefinition` with sensible defaults.
- `makeFakeCollection(docs)` at line 178 — returns a minimal `Collection<AgentDefinition>` backed by an in-memory array.

`AgentRegistry` is instantiated directly as `new AgentRegistry(makeFakeCollection([def]))` followed by `await registry.load()`. No wrapper helper exists; do not invent one. Append this describe block:

```typescript
describe("origin routing", () => {
  it("findByOrigin returns the catching agent", async () => {
    const registry = new AgentRegistry(
      makeFakeCollection([
        makeDefinition({ _id: "production-support", name: "Sige", catches: ["dodi-shop"] }),
        makeDefinition({ _id: "executive-assistant", name: "Rae" }),
      ]),
    );
    await registry.load();
    expect(registry.findByOrigin("dodi-shop")?.id).toBe("production-support");
  });

  it("findByOrigin returns undefined for unknown slug", async () => {
    const registry = new AgentRegistry(
      makeFakeCollection([
        makeDefinition({ _id: "production-support", name: "Sige", catches: ["dodi-shop"] }),
      ]),
    );
    await registry.load();
    expect(registry.findByOrigin("unknown")).toBeUndefined();
  });

  it("first-sorted agent wins on origin conflict", async () => {
    const registry = new AgentRegistry(
      makeFakeCollection([
        makeDefinition({ _id: "zeta", name: "Zeta", catches: ["shared"] }),
        makeDefinition({ _id: "alpha", name: "Alpha", catches: ["shared"] }),
      ]),
    );
    await registry.load();
    expect(registry.findByOrigin("shared")?.id).toBe("alpha");
  });

  it("disabled agents do not catch origins", async () => {
    const registry = new AgentRegistry(
      makeFakeCollection([
        makeDefinition({
          _id: "production-support",
          name: "Sige",
          catches: ["dodi-shop"],
          disabled: true,
        }),
      ]),
    );
    await registry.load();
    expect(registry.findByOrigin("dodi-shop")).toBeUndefined();
  });

  it("reload picks up new catches entries", async () => {
    // makeFakeCollection returns a closure over a mutable docs array — mutate
    // it directly between load() calls to simulate a DB update.
    const docs = [makeDefinition({ _id: "production-support", name: "Sige" })];
    const col = makeFakeCollection(docs);
    const registry = new AgentRegistry(col);
    await registry.load();
    expect(registry.findByOrigin("dodi-shop")).toBeUndefined();

    docs[0] = makeDefinition({ _id: "production-support", name: "Sige", catches: ["dodi-shop"] });
    await registry.load();
    expect(registry.findByOrigin("dodi-shop")?.id).toBe("production-support");
  });
});
```

**Note on "disabled excluded":** this works because `load()` removes disabled agents from `this.agents` upstream (lines 44-52), so `rebuildOriginIndex` iterating `this.agents.values()` never sees them. The test verifies the end-to-end behavior, not a filter inside `rebuildOriginIndex`.

**Note on the reload test:** `makeFakeCollection` at line 178 takes a `docs` array and the returned collection's `find()` reads from the same array reference. Mutating the array between `load()` calls is the existing pattern used in tests further down the file (around line 260 — `docs[0] = makeDefinition(...)`). Reuse that pattern; do not introduce a new helper.

- [ ] **Step 6:** Run tests.

```bash
cd ~/github/hive && npm test -- agent-registry
```

Expected: all new tests pass.

- [ ] **Step 7:** Commit.

```bash
git add src/agents/agent-registry.ts src/agents/agent-registry.test.ts
git commit -m "feat(registry): add originToAgent index and findByOrigin"
```

---

## Task H3: Hive — dispatcher origin routing step 0.6

**Repo:** `~/github/hive`

**Files:**
- Modify: `src/channels/dispatcher.ts` (resolveAgents at line 329+)
- Test: `src/channels/dispatcher.test.ts`

- [ ] **Step 1:** Insert origin lookup in `resolveAgents`.

In `src/channels/dispatcher.ts`, find the team routing block (line 337-340):

```typescript
    // 0.5 Team routing — DMs resolve to channel member, channels use @mention or triage
    if (item.source.kind === "team") {
      return this.resolveFromTeam(item);
    }
```

Immediately after, add the origin lookup (new step 0.6):

```typescript
    // 0.6 Origin routing — single-purpose apps declare identity via connect-time tag
    //     Must run before channel/thread/name so shop-floor messages can't accidentally
    //     land on an agent whose name appears in the text.
    const origin = item.meta?.origin as string | undefined;
    if (origin) {
      const match = this.registry.findByOrigin(origin);
      if (match) {
        return [{ agentId: match.id, skipTriage: false }];
      }
      log.warn("Origin not routed", {
        origin,
        deviceId: item.meta?.deviceId as string | undefined,
        text: item.text.slice(0, 50),
      });
      return [];
    }
```

- [ ] **Step 2:** Extend the mock registry with `findByOrigin`.

`src/channels/dispatcher.test.ts` has `makeMockRegistry()` at line 42. It currently exposes `get`, `getAll`, `findByChannel`, `findByKeyword`, `findByName`, `findAllByName`. Add `findByOrigin` — rebuild a small origin map from the in-memory `agents` Map at call time (the mock is cheap; no need to match the real registry's indexed approach):

```typescript
    findByOrigin: (slug: string) => {
      for (const a of Array.from(agents.values())) {
        if (a.disabled) continue;
        if ((a.catches ?? []).includes(slug)) return a;
      }
      return undefined;
    },
```

Place it next to `findByChannel` in the returned object. Also add `catches: ["dodi-shop"]` to one existing agent in the `makeMockRegistry` body (e.g. add a new "production-support" agent or attach `catches` to `jasper` — whichever keeps existing tests untouched). Adding a new agent is cleaner:

```typescript
  agents.set("production-support", {
    id: "production-support",
    name: "Sige",
    channels: ["agent-sige"],
    passiveChannels: [],
    keywords: [],
    catches: ["dodi-shop"],
    isDefault: false,
  });
```

- [ ] **Step 3:** Add tests.

Existing infrastructure in `src/channels/dispatcher.test.ts`:
- `makeWorkItem(overrides)` at line 30 (default `source.kind === "slack"`)
- `makeMockRegistry()` at line 42
- `makeMockAgentManager()` at line 122 — returns an object with `sendMessage: vi.fn().mockResolvedValue(...)`
- `makeMockHealthReporter()` at line 134
- `makeMockAdapter()` at line 140
- The `describe("Dispatcher routing", …)` block at line 215 constructs `new Dispatcher(registry, agentManager, healthReporter, "executive-assistant")` in its `beforeEach` (line 221-231).

Existing tests assert routing via `expect(agentManager.sendMessage).toHaveBeenCalledWith("<agentId>", item)` (e.g. line 239). Match that assertion style exactly.

Append a new describe block after the `Dispatcher routing` block:

```typescript
describe("origin routing", () => {
  let dispatcher: Dispatcher;
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    const healthReporter = makeMockHealthReporter();
    adapter = makeMockAdapter();
    dispatcher = new Dispatcher(
      registry as any,
      agentManager as any,
      healthReporter as any,
      "executive-assistant",
    );
    dispatcher.registerAdapter(adapter as any);
  });

  it("routes app-source WorkItem to the catching agent", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "hi from shop floor",
      meta: { origin: "dodi-shop", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("production-support", item);
  });

  it("drops when origin is unknown", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "hi",
      meta: { origin: "nonexistent", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).not.toHaveBeenCalled();
  });

  it("origin wins over name addressing", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "hey Jasper can you check this",
      meta: { origin: "dodi-shop", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("production-support", item);
  });

  it("explicit targetAgentId beats origin", async () => {
    const item = makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "status",
      meta: { origin: "dodi-shop", targetAgentId: "executive-assistant", deviceId: "dev1" },
    });
    await dispatcher.dispatch(item);
    expect(agentManager.sendMessage).toHaveBeenCalledWith("executive-assistant", item);
  });
});
```

**Note on "team routing beats origin":** the existing test file has no team-store fixture, and wiring one up is out of scope for this task. Skip the unit test for this precedence rule and rely on the manual end-to-end test in Task H6. The precedence is guaranteed by the step ordering in `resolveAgents` (step 0.5 `team` branch returns before step 0.6 `origin` runs), which is readable in diff review.

- [ ] **Step 4:** Run tests.

```bash
cd ~/github/hive && npm test -- dispatcher
```

Expected: all new tests pass, existing tests still pass.

- [ ] **Step 5:** Commit.

```bash
git add src/channels/dispatcher.ts src/channels/dispatcher.test.ts
git commit -m "feat(dispatcher): route WorkItems by meta.origin via agent catches"
```

---

## Task H4: Hive — ws-adapter origin propagation

**Repo:** `~/github/hive`

**Files:**
- Modify: `src/channels/ws/ws-adapter.ts` (Device interface line 35, upgrade handler lines 100-140, comment lines 134-136, message branch line 225, image branch line 250, onProcessingStart line 353)
- Test: `src/channels/ws/ws-adapter.test.ts`

- [ ] **Step 1:** Extend `Device` interface with `origin?: string`.

In `src/channels/ws/ws-adapter.ts`, replace the `Device` interface at line 35-39:

```typescript
interface Device {
  _id: string;
  name: string;
  defaultAgentId: string;
  origin?: string;
}
```

- [ ] **Step 2:** Read `origin` in the upgrade handler and put it on the synthetic Device.

Find the upgrade handler around lines 126-140. Replace the synthetic Device construction block:

```typescript
      const deviceId = url.searchParams.get("deviceId");
      const name = url.searchParams.get("name");
      if (!deviceId || !name) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      const origin = url.searchParams.get("origin") ?? undefined;

      // Synthetic device — loopback traffic comes from beekeeper's team proxy.
      // Routing on the app path uses meta.origin, populated below from the
      // connection-level origin tag that beekeeper forwards via query param.
      const device: Device = { _id: deviceId, name, defaultAgentId: "", origin };
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req, device);
      });
```

Note: this replaces the existing comment at lines 134-136 that referenced "targetAgentId always carried on the wire" — that framing was inaccurate. The new comment reflects how routing actually works.

- [ ] **Step 3:** Populate `meta.origin` in the `type:"message"` branch.

Find the message branch around line 225. Replace the WorkItem construction inside the `if (msg.type === "message") {` block:

```typescript
          if (msg.type === "message") {
            this.send(ws, { type: "ack", id: msg.id });

            const workItem: WorkItem = {
              id: msg.id || randomUUID(),
              text: msg.text,
              source: {
                kind: "app",
                id: deviceId,
                label: `app:${device.name}`,
                adapterId: "ws",
              },
              sender: deviceId,
              senderName: device.name,
              threadId: `app:${deviceId}`,
              timestamp: new Date(),
              meta: {
                deviceId,
                defaultAgentId: device.defaultAgentId,
                origin: device.origin,
              },
            };

            this.onWorkItem(workItem);
          }
```

- [ ] **Step 4:** Populate `meta.origin` in the `type:"image"` branch.

Find the image branch around line 250. Add `origin: device.origin` to the `meta` object in the same place:

```typescript
              const workItem: WorkItem = {
                id: msg.id || randomUUID(),
                text: `[Photo: ${msg.filename}]`,
                source: {
                  kind: "app",
                  id: deviceId,
                  label: `app:${device.name}`,
                  adapterId: "ws",
                },
                sender: deviceId,
                senderName: device.name,
                threadId: `app:${deviceId}`,
                timestamp: new Date(),
                files: [processed],
                meta: {
                  deviceId,
                  defaultAgentId: device.defaultAgentId,
                  origin: device.origin,
                },
              };
```

- [ ] **Step 5:** Guard `onProcessingStart` against app-source items.

Find `onProcessingStart` around lines 353-364. Add an early return at the top of the method:

```typescript
  async onProcessingStart(item: WorkItem): Promise<void> {
    // App-source items don't know their target agent until after resolveAgents runs.
    // Skip the typing indicator rather than emit an empty-agentId frame. Triage's
    // "On it..." ack already handles the latency feel.
    if (item.source.kind === "app") return;

    const deviceId = item.meta?.deviceId as string;
    if (!deviceId) return;

    const ws = this.connections.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.send(ws, {
        // ... existing body ...
```

Keep the rest of the method body intact.

- [ ] **Step 6:** Add tests.

Existing helpers in `src/channels/ws/ws-adapter.test.ts` (inside `describe("WsAdapter upgrade handler", …)` at line 163):
- `makeFakeSocket(remoteAddress)` at line 173 — fake net socket, tracks `writtenChunks` and `destroyed`.
- `startAdapter()` at line 193 — constructs a `WsAdapter` with stub registry/manager on a random port.
- `getUpgradeListener(a)` at line 202 — pulls the upgrade listener off the underlying http server so it can be invoked without a real socket.

The existing test at line 208 ("accepts internal=1 from ::ffff:127.0.0.1…") already demonstrates the pattern: spy on `wss.handleUpgrade`, attach a listener to `wss` for the `"connection"` event to capture the synthetic `Device`, then call the upgrade listener directly with a fake request. Match that pattern exactly — do not introduce real WebSocket connections or `waitFor` helpers.

Append these tests inside the same describe block:

```typescript
  it("upgrade with ?origin=dodi-shop surfaces origin on synthetic Device", async () => {
    const a = await startAdapter();

    const wss = (a as any).wss;
    vi.spyOn(wss, "handleUpgrade").mockImplementation(((
      _req: any,
      _socket: any,
      _head: any,
      cb: any,
    ) => {
      const fakeWs = new EventEmitter() as any;
      fakeWs.close = vi.fn();
      fakeWs.send = vi.fn();
      cb(fakeWs);
    }) as any);

    const emittedDevices: any[] = [];
    wss.on("connection", (_ws: any, _req: any, device: any) => {
      emittedDevices.push(device);
    });

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?internal=1&deviceId=dev1&name=Shop&origin=dodi-shop",
      headers: {},
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };
    const socket = makeFakeSocket("::ffff:127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(emittedDevices).toHaveLength(1);
    expect(emittedDevices[0]._id).toBe("dev1");
    expect(emittedDevices[0].origin).toBe("dodi-shop");
  });

  it("upgrade without origin leaves device.origin undefined", async () => {
    const a = await startAdapter();

    const wss = (a as any).wss;
    vi.spyOn(wss, "handleUpgrade").mockImplementation(((
      _req: any,
      _socket: any,
      _head: any,
      cb: any,
    ) => {
      const fakeWs = new EventEmitter() as any;
      fakeWs.close = vi.fn();
      fakeWs.send = vi.fn();
      cb(fakeWs);
    }) as any);

    const emittedDevices: any[] = [];
    wss.on("connection", (_ws: any, _req: any, device: any) => {
      emittedDevices.push(device);
    });

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?internal=1&deviceId=dev1&name=Shop",
      headers: {},
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };
    const socket = makeFakeSocket("::ffff:127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(emittedDevices[0].origin).toBeUndefined();
  });
```

**Note on the message-branch / image-branch meta.origin population:** these happen inside the `ws.on("message", ...)` closure at lines 164-288, which is wired to a real `WebSocket` instance. Unit-testing that path in isolation requires driving a message through a fake `ws` — possible but noisy. **Skip the unit test for meta.origin propagation from Device → WorkItem**; the Device-level test above plus the manual end-to-end test in Task H6 are sufficient. If the reviewer insists on coverage, add a test that instantiates the adapter, manually invokes the `message` event on a fake ws held over from `wss.emit("connection", ...)`, and asserts the captured `onWorkItem` call's `meta.origin` — but that's ~40 lines of fake-socket plumbing for a one-line assertion, and the code itself is trivially auditable.

- [ ] **Step 7:** Run tests.

```bash
cd ~/github/hive && npm test -- ws-adapter
```

Expected: new tests pass, existing tests still pass.

- [ ] **Step 8:** Commit.

```bash
git add src/channels/ws/ws-adapter.ts src/channels/ws/ws-adapter.test.ts
git commit -m "feat(ws-adapter): read origin query param and propagate via meta.origin"
```

---

## Task H5: Hive — production-support seed claims `dodi-shop`

**Repo:** `~/github/hive`

**Files:**
- Modify: `plugins/dodi/agent-seeds/production-support.yaml`

- [ ] **Step 1:** Add `catches` field to the seed.

In `plugins/dodi/agent-seeds/production-support.yaml`, add `catches` in the Routing section next to `channels`:

```yaml
_id: production-support
name: Production Support
model: claude-sonnet-4-6
icon: ":hammer_and_wrench:"
channels:
  - agent-sige
catches:
  - dodi-shop
homeBase: agent-production-support
```

- [ ] **Step 2:** Update the live MongoDB doc.

`setup/setup-seeds.ts` is skip-only on existing docs (confirmed at its lines 46-50), so running `npm run setup:seeds` will log `SKIP production-support — already exists` and do nothing. The YAML change in Step 1 is for fresh installs and source-of-truth; the live DB needs a direct update:

```bash
mongosh hive --eval 'db.agent_definitions.updateOne({_id: "production-support"}, {$set: {catches: ["dodi-shop"]}})'
```

Expected: `{ acknowledged: true, matchedCount: 1, modifiedCount: 1, ... }`.

The Task H1 patch to `setup-seeds.ts` ensures a fresh-install re-import would pick up the field; this step handles the already-deployed instance.

- [ ] **Step 3:** Verify the DB has the field.

```bash
mongosh hive --eval 'db.agent_definitions.findOne({_id: "production-support"}, {catches: 1})'
```

Expected: `{ _id: 'production-support', catches: [ 'dodi-shop' ] }`.

- [ ] **Step 3a:** Send SIGUSR1 to reload agent definitions in the running hive service (so the new `catches` is indexed without a restart).

```bash
launchctl kill SIGUSR1 "gui/$(id -u)/com.hive.agent"
```

Expected: a log line from `agent-registry` showing the reload — followed eventually by `Loaded agent` for production-support. Verify with `tail ~/services/hive/logs/hive.log`.

- [ ] **Step 4:** Commit.

```bash
git add plugins/dodi/agent-seeds/production-support.yaml
git commit -m "feat(seeds): production-support catches dodi-shop origin"
```

---

## Task H6: Hive — quality gate, PR, end-to-end verification

**Repo:** `~/github/hive`

- [ ] **Step 1:** Full quality gate.

```bash
cd ~/github/hive && npm run check
```

Expected: typecheck + lint + format + test all pass. Fix anything that breaks before proceeding.

- [ ] **Step 2:** Open PR.

```bash
gh pr create --title "feat: app origin routing via agent catches field" --body "$(cat <<'EOF'
## Summary
- New `catches: string[]` field on agent definitions
- Registry builds `originToAgent` index at load with deterministic conflict resolution
- Dispatcher `resolveAgents` step 0.6: lookup `meta.origin` → catching agent, hard-drop on unknown
- ws-adapter reads `?origin=` on upgrade, stashes on Device, populates `meta.origin` on app message + image branches
- `onProcessingStart` guarded on app-source to avoid empty-agentId typing frames
- production-support (Sige) catches `dodi-shop`

Depends on beekeeper release that forwards `origin` to hive's upstream URL (separate PR in keepur/beekeeper).

Spec: docs/specs/2026-04-13-app-origin-routing-design.md
Plan: docs/plans/2026-04-13-app-origin-routing.md

## Test plan
- [x] Unit tests in agent-registry, dispatcher, ws-adapter
- [x] npm run check passes
- [ ] Manual end-to-end after deploy: shop phone sends message → lands in Sige
EOF
)"
```

- [ ] **Step 3:** After CI green + merge + deploy, verify end-to-end.

**Preconditions:** beekeeper release from Task B3 is published AND deployed on the Mac Mini.

1. Tail hive logs:
   ```bash
   tail -f ~/services/hive/logs/hive.log | grep -iE "ws-adapter|origin|dispatcher"
   ```
2. Tail beekeeper logs:
   ```bash
   tail -f ~/.beekeeper/logs/beekeeper.log | grep -iE "team|origin"
   ```
3. On May's shop-floor phone, open dodi-shop-ios (with the updated build from the follow-up iOS PR — if that's not ready yet, manually craft a WS connection with `?origin=dodi-shop` via `wscat` to beekeeper for a smoke test).
4. Send message "test from shop floor".
5. Expect:
   - Beekeeper: `Team upstream open` with deviceId
   - Hive ws-adapter: `Device connected` with name "May"
   - Hive dispatcher: **no** `"No agent found for work item"` warning
   - Hive agent-runner: `Sending prompt to agent` with `agent: "production-support"`
   - Slack #agent-sige channel receives audit post (if audit adapter is on)
   - Response delivered back to the app

If the dispatcher logs `Origin not routed`, confirm `catches` made it into MongoDB via Task H5 step 3.

---

## Follow-up (separate repo, not in this plan)

**dodi-shop-ios:** add `&origin=dodi-shop` to the WS URL in `DodiShop/Managers/WebSocketManager.swift:34`. One-line change, TestFlight release. Schedule after Tasks B1–B3 and H1–H6 are all merged and deployed.
