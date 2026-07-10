# KPR-308 — LAN-Direct Routing Slice (Option b) Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Ship the hive-side option-(b) slice of KPR-308: a `floorCritical` agent flag, a dispatcher outage-mode delivery-preference guard behind an `OutageStateProvider` seam (dormant stub until KPR-306 wires the breaker), and `WsAdapter.deliverBroadcast` for diverted items — plus the spec's verify-only manual LAN reachability checklist. **No beekeeper code changes.**

**Architecture:** Agent-initiated output (scheduler/callback turns synthesized with a Slack source) currently dies with the WAN because delivery is source-keyed. This slice adds one guard at the dispatcher's two agent-response delivery sites: when the outage provider reports true AND the handling agent is `floorCritical` AND the item is slack/scheduler-sourced, deliver via WS broadcast to all connected app devices instead of the (dead) source adapter, falling through to normal delivery when zero devices are connected or the broadcast fails. The breaker dependency is isolated behind a `() => boolean` provider so this PR and KPR-306 can land in either order.

**Tech Stack:** TypeScript (strict), Node 22, vitest, `ws` — all existing; no new dependencies.

**Spec:** `docs/epics/kpr-305/kpr-308-spec.md` (review-clean r2; operator D3 ruling = option (b), B-1 posture blessed, beekeeper hardening deferred to KPR-333 rate-limit `/pair` + KPR-334 TLS-on-LAN).

---

## ⚠ MANDATORY Task 0 — Re-confirm at execution HEAD (maturity-first discipline)

This plan was written against branch `mature/KPR-308` @ `7b9adbb` and will be implemented **later against a moved main**. Before writing any code, re-verify the spec's §2 evidence table AND every citation below at the execution HEAD. If any anchor has drifted materially (function moved, signature changed, delivery sites restructured), STOP and adjust the plan — or demote to the spec lane if the drift is architectural.

- [ ] **Step 0.1:** Re-verify each citation this plan depends on:

| # | Claim | Anchor @ 7b9adbb | Re-check command |
|---|---|---|---|
| C1 | `AgentDefinition` doc type; no `floorCritical` yet | `src/types/agent-definition.ts:6-81` | `grep -n "floorCritical" src/types/agent-definition.ts` (expect empty) |
| C2 | `toAgentConfig` is the defaulting site (no `fromDoc` parser exists) | `src/types/agent-definition.ts:120` | `grep -rn "fromDoc" src/` (expect empty) |
| C3 | `AgentConfig` projected type | `src/types/agent-config.ts:9-50` | read file |
| C4 | Dispatcher adapters `Map` keyed by `adapter.id`; delivery adapter = `source.adapterId ?? source.kind` | `src/channels/dispatcher.ts:44`, `:80-82`, `:200`, `:597` | `grep -n "adapterId ?? item.source.kind\|adapterId ?? effectiveItem.source.kind" src/channels/dispatcher.ts` |
| C5 | The two agent-response delivery blocks (success paths) | `dispatcher.ts:228-235` (dispatch) and `:615-621` (dispatchToAgent) | read both blocks; they must still be `if (adapter) { try { await adapter.deliver(workResult) } catch { … retryQueue?.enqueue … } }` |
| C6 | Scheduler synthesizes `source: { kind: "slack", id: homeChannel }`, `meta: { targetAgentId }` | `src/scheduler/scheduler.ts:230-239` | `grep -n 'kind: "slack"' src/scheduler/scheduler.ts` |
| C7 | `ChannelKind` includes `"scheduler"` (defensive leg; nothing produces it) | `src/types/work-item.ts:1-11` | read file |
| C8 | `WsAdapter.deliver()` requires `meta.deviceId`; buffers to `pendingMessages` when device offline | `src/channels/ws/ws-adapter.ts:344-393` | read `deliver()` |
| C9 | `WsAdapter.id === "ws"`, `kind === "app"`; `connections: Map<string, WebSocket>`; `send()` gates on `readyState === WebSocket.OPEN` | `ws-adapter.ts:56-57`, `:62`, `:805-809` | read file |
| C10 | `buildAgentList()` + `AgentInfo` shape | `ws-adapter.ts:466-489`, `src/channels/ws/protocol.ts:175-187` | read both |
| C11 | Admin `agent_create` builds the doc explicitly from `fields` bag; `agent_update` passes `fields` through `merged` with per-field canonicalization (see `maxConcurrent`→`spawnBudget` block) | `src/admin/admin-mcp-server.ts:290-349`, `:395-460` | read both handlers |
| C12 | `dispatcher.setRetryQueue(retryQueue)` wiring point in index | `src/index.ts:735` | `grep -n "setRetryQueue" src/index.ts` |
| C13 | WS adapter registered under `config.ws.enabled` | `src/index.ts:645-665` | read block |
| C14 | Scheduler items are a no-op in `SlackAdapter.onProcessingStart` (no `slackTs`/`slackThreadTs` in meta → skip) | `src/channels/slack-adapter.ts:152-159` + C6 | read both |
| C15 | Hive ws-adapter binds loopback only (unchanged by this slice) | `ws-adapter.ts:337` | `grep -n '127.0.0.1' src/channels/ws/ws-adapter.ts` |

- [ ] **Step 0.2:** Re-verify the spec §2 evidence table rows for the hive repo (rows 1-9 of the spec table) the same way. Beekeeper rows (B-1/B-2 facts) are verify-only rollout items — see Manual LAN Verification Checklist below; they do not gate coding.
- [ ] **Step 0.3:** Confirm KPR-306 status at HEAD: `grep -rn "OutageStateProvider\|setOutageStateProvider\|ProviderCircuitOpenError" src/`. If KPR-306 already landed a provider/seam, reconcile naming with its shape instead of introducing a duplicate — the seam contract in Task 4 absorbs a rename, not a redesign. **Do not import KPR-306's breaker implementation into the dispatcher either way.**

---

## Testing Contract

### Required Test Groups

- Unit: **required**
  - Scope: `toAgentConfig` floorCritical projection; admin MCP `agent_create`/`agent_update` floorCritical write boundary; `WsAdapter.deliverBroadcast`; dispatcher outage-diversion guard matrix; `isBroadcastCapable` seam contract (real `WsAdapter` instance passes the guard); `buildAgentList` floorCritical exposure.
  - Reason: all new behavior is pure in-process logic over injectable collaborators — the codebase's established pattern (fake adapters/registries in `dispatcher.test.ts`, fake Mongo collections in `admin-mcp-server.test.ts`, injected fake sockets in `ws-adapter.test.ts`).
  - Minimum assertions:
    - `toAgentConfig`: `floorCritical` absent → `false`; `true` → `true`; `false` → `false`; garbage (`"yes"`, `1`) → `false` (spec §5.7).
    - Dispatcher matrix (spec §5.7): breaker open/closed × floorCritical true/false × ws connections 0/n × source kind slack/scheduler/app × result error present/absent — diversion fires **only** when the result carries no error ∧ breaker open ∧ floorCritical ∧ source ∈ {slack, scheduler} ∧ broadcast count > 0; app-sourced replies never divert; sms never diverts; zero-connection broadcast falls through to source adapter; broadcast exception falls through to source adapter; ws adapter unregistered falls through; a result carrying an error never diverts even when every other condition holds (review advisory — error-carrying results always deliver via the source adapter, no error frames on the floor broadcast). The `scheduler` source-kind cell is **defensive** — no live producer exists today (C6/C7); the test exercises the type-union branch knowingly. The matrix also exercises the fan-out delivery site (`dispatchToAgent`, site 2) directly with one test, in addition to the `dispatch()` (site 1) coverage above — closing both delivery-site seams.
    - `deliverBroadcast`: n open connections all receive the standard `message` frame (agentId + resolved agentName + replyTo); non-OPEN sockets skipped and not counted; returns accurate count; `pendingMessages` untouched (no offline buffering); agentName falls back to id when agent missing from registry.
    - Admin MCP: `agent_create` persists `floorCritical: true` from fields bag and `false` when absent; `agent_update` round-trips `floorCritical` and coerces garbage to strict boolean at the write boundary.
    - Seam: a real `WsAdapter` instance satisfies `isBroadcastCapable`; a plain mock adapter without the method does not.

- Integration: **not-required**
  - Scope: n/a
  - Reason: the slice's only cross-module boundary (dispatcher ↔ WsAdapter) is a single structural method contract (`deliverBroadcast(result) → Promise<number>`), covered from both sides in unit tests plus the `isBroadcastCapable` seam-contract test against a **real** WsAdapter instance. No new DB, network, or process boundary is introduced; the breaker integration is explicitly out of scope (KPR-306's later wiring step).
  - Harness: not-applicable
  - Minimum assertions: n/a

- E2E: **not-required**
  - Scope: n/a
  - Reason: a true end-to-end outage exercise needs KPR-306's breaker (not landed), a live beekeeper, and a LAN device — the transport half is covered by the documented Manual LAN Verification Checklist (operator-run, rollout gate), and the breaker half belongs to KPR-306's integration lane.
  - Harness: not-applicable
  - Minimum assertions: n/a

### Critical Flows

- Outage diversion: floor-critical agent's scheduler-synthesized (slack-sourced) turn output reaches connected app devices via broadcast when the provider reports outage.
- Fall-through: zero connected devices or broadcast failure → item delivered via the normal source adapter with existing retry-queue semantics.
- Dormancy: with the default stub provider (`() => false`), behavior is byte-for-byte identical to today on every path.

### Regression Surface

- Source-keyed delivery for app/team/sms-originated items (must never divert — already routes correctly).
- WS `deliver()` per-device path incl. `pendingMessages` offline buffering (broadcast must not touch it).
- Retry-queue enqueue semantics at both delivery sites (guard falls through into the existing try/catch shape).
- Status-query interception delivery (system agent — not in registry → guard self-excludes).
- Admin MCP `spawnBudget`/`maxConcurrent` canonicalization and KPR-184/KPR-221 delegateServers validation (adjacent code in both handlers).
- `toAgentConfig` existing field projection (no other field's default may change).
- Note: routing both fan-out delivery sites through the shared helper adds a `log.warn` to the fan-out failure path that previously enqueued silently — intentional, benign.
- Note: partial-broadcast double-delivery — one device receiving the frame before a later connection's `send()` throws mid-loop — is fail-safe by design (a duplicate delivered during an outage beats one lost) and the `readyState === OPEN` gate makes the scenario near-impossible in practice.

### Commands

- Unit (targeted): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/types/agent-definition.test.ts src/admin/admin-mcp-server.test.ts src/channels/ws/ws-adapter.test.ts src/channels/dispatcher.test.ts`
- Integration: not-applicable
- E2E: not-applicable
- Broader regression (repo check gate): `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- None new. Existing vitest suites already model every collaborator: `dispatcher.test.ts` fake registry/adapters, `admin-mcp-server.test.ts` fake Mongo `Db` + SDK mock, `ws-adapter.test.ts` injected fake WebSocket objects (no server needed for `deliverBroadcast` — populate `(adapter as any).connections` directly).
- Env stubs `SLACK_APP_TOKEN`/`SLACK_BOT_TOKEN`/`SLACK_SIGNING_SECRET` on the command line (repo check-gate convention).

### Non-Required Rationale

- Integration: single structural seam covered from both sides in unit tests + real-instance contract test; no new process/db/network boundary.
- E2E: requires unlanded KPR-306 breaker + external beekeeper + physical LAN device; transport half is the operator-run manual checklist below, breaker half is KPR-306's lane.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

| File | Change | Responsibility |
|---|---|---|
| `src/types/agent-definition.ts` | modify | `floorCritical?: boolean` on the doc type; strict-boolean default in `toAgentConfig` |
| `src/types/agent-config.ts` | modify | `floorCritical?: boolean` on the projected config |
| `src/admin/admin-mcp-server.ts` | modify | accept + persist `floorCritical` (create defaults false; update coerces at write boundary); surface in `agent_get` |
| `src/channels/channel-adapter.ts` | modify | `BroadcastCapableAdapter` interface + `isBroadcastCapable` type guard (the dispatcher↔ws structural seam) |
| `src/channels/ws/ws-adapter.ts` | modify | `deliverBroadcast(result): Promise<number>`; `floorCritical` in `buildAgentList` |
| `src/channels/ws/protocol.ts` | modify | `floorCritical: boolean` on `AgentInfo` |
| `src/channels/dispatcher.ts` | modify | `OutageStateProvider` type + setter + stub default; `tryOutageDiversion`; shared `deliverAgentResult` helper replacing the two success-delivery blocks |
| `src/index.ts` | modify | explicit dormant seam wiring + KPR-306 hand-off comment |
| `src/types/agent-definition.test.ts` | modify (tests) | floorCritical projection group |
| `src/admin/admin-mcp-server.test.ts` | modify (tests) | floorCritical write-boundary group |
| `src/channels/ws/ws-adapter.test.ts` | modify (tests) | deliverBroadcast group + buildAgentList assertion |
| `src/channels/dispatcher.test.ts` | modify (tests) | outage-diversion matrix + seam-contract test |

**Config surface: none.** Per spec §5.5, no `hive.yaml` key is added — `floorCritical` is the only knob and lives on the agent definition; the outage master state arrives through the provider. **Deliberately dropped (with spec's blessing):** the optional `hive doctor` line (§5.6 — noise while no provider is wired; KPR-306 surfaces breaker state itself). **Kept (small):** `agent_list` exposure of `floorCritical` (§5.1 nice-to-have / open question 4) — one field in two files; trim Task 5 if PR review flags bloat.

**Cross-spec decoupling (binding):** KPR-306's spec (parallel review) exports an Open-Circuit Contract (`ProviderCircuitOpenError` + `CircuitBreakerSnapshot`). This plan implements against the `OutageStateProvider` interface **only**; wiring the breaker snapshot into the provider is a later integration step — possibly in KPR-306's or KPR-307's lane — **not this plan's**.

---

### Task 1: `floorCritical` on AgentDefinition + AgentConfig (+ projection tests)

**Files:**
- Modify: `src/types/agent-definition.ts:25-30` (Routing section), `:120-166` (`toAgentConfig`)
- Modify: `src/types/agent-config.ts:17-20`
- Test: `src/types/agent-definition.test.ts`

- [ ] **Step 1.1:** In `src/types/agent-definition.ts`, add the field to the `AgentDefinition` interface, in the Routing block after `isDefault: boolean;`:

```typescript
  /**
   * KPR-308: outage-mode delivery preference. When true and the dispatcher's
   * outage-state provider reports an active outage, this agent's slack/
   * scheduler-sourced output is diverted to the app (WS) channel via
   * broadcast so the shop floor keeps receiving it while the WAN is down.
   * Optional on the doc; projected to a strict boolean (default false) by
   * toAgentConfig — liberal-loader pattern, garbage coerces to false.
   */
  floorCritical?: boolean;
```

- [ ] **Step 1.2:** In `toAgentConfig` (same file), add the projection line directly after `isDefault: doc.isDefault ?? false,`:

```typescript
    // KPR-308: strict-boolean coercion — absent/garbage → false (spec §5.7).
    floorCritical: doc.floorCritical === true,
```

- [ ] **Step 1.3:** In `src/types/agent-config.ts`, add to `AgentConfig` after `isDefault: boolean;`:

```typescript
  /**
   * KPR-308: outage-mode delivery preference (see AgentDefinition.floorCritical).
   * Always a strict boolean after toAgentConfig projection; optional on the
   * type so hand-built configs (tests, fixtures) don't churn.
   */
  floorCritical?: boolean;
```

- [ ] **Step 1.4:** In `src/types/agent-definition.test.ts`, add a test group (env stubs already exist at the top of the file; `makeDefinition` carries no `floorCritical`, giving the absent case):

```typescript
describe("toAgentConfig — floorCritical projection (KPR-308)", () => {
  it("defaults to false when absent", () => {
    expect(toAgentConfig(makeDefinition()).floorCritical).toBe(false);
  });

  it("passes true through", () => {
    expect(toAgentConfig(makeDefinition({ floorCritical: true })).floorCritical).toBe(true);
  });

  it("passes false through", () => {
    expect(toAgentConfig(makeDefinition({ floorCritical: false })).floorCritical).toBe(false);
  });

  it("coerces garbage to false (liberal loader)", () => {
    expect(toAgentConfig(makeDefinition({ floorCritical: "yes" as unknown as boolean })).floorCritical).toBe(false);
    expect(toAgentConfig(makeDefinition({ floorCritical: 1 as unknown as boolean })).floorCritical).toBe(false);
  });
});
```

- [ ] **Step 1.5:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/types/agent-definition.test.ts`
Expected: all tests pass, including 4 new `floorCritical projection` tests.

- [ ] **Step 1.6:** Commit

```bash
git add src/types/agent-definition.ts src/types/agent-config.ts src/types/agent-definition.test.ts
git commit -m "KPR-308: add floorCritical to AgentDefinition/AgentConfig with strict-boolean projection"
```

---

### Task 2: Admin MCP passthrough (`agent_create` / `agent_update` / `agent_get`)

**Files:**
- Modify: `src/admin/admin-mcp-server.ts` (create doc construction ~`:314`; update canonicalization ~`:440-446`; get display ~`:173`)
- Test: `src/admin/admin-mcp-server.test.ts`

- [ ] **Step 2.1:** In the `agent_create` handler's doc construction, add directly after `isDefault: (f.isDefault as boolean) ?? false,`:

```typescript
            // KPR-308: strict-boolean at the write boundary — garbage never persists.
            floorCritical: f.floorCritical === true,
```

- [ ] **Step 2.2:** In the `agent_update` handler, after the `maxConcurrent` → `spawnBudget` canonicalization block (`delete merged.maxConcurrent;`), add:

```typescript
          // KPR-308: floorCritical is a plain boolean (no cross-field
          // constraints — KPR-184-style delegateServers rules do NOT apply).
          // Coerce at the write boundary so docs stay clean.
          if ("floorCritical" in merged) merged.floorCritical = merged.floorCritical === true;
```

- [ ] **Step 2.3:** In the `agent_get` handler, after `lines.push(\`Is Default: ${doc.isDefault ?? false}\`);`, add:

```typescript
          lines.push(`Floor Critical: ${doc.floorCritical ?? false}`);
```

- [ ] **Step 2.4:** In `src/admin/admin-mcp-server.test.ts`, add a test group (uses the existing `makeTools`/`getHandler`/`makeBaseAgent`/store fixtures):

```typescript
describe("KPR-308 — floorCritical write boundary", () => {
  beforeEach(() => {
    agentDocsStore = new Map();
    agentVersionsStore = [];
  });

  it("agent_create persists floorCritical: true from the fields bag", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    const result = await handler({
      _id: "floor-agent",
      name: "Floor Agent",
      model: "haiku",
      homeBase: "agent-floor",
      roles: ["Shop Floor"],
      fields: { floorCritical: true },
    });
    expect(result.isError).toBeUndefined();
    expect(agentDocsStore.get("floor-agent").floorCritical).toBe(true);
  });

  it("agent_create defaults floorCritical to false when absent", async () => {
    const handler = getHandler(makeTools(), "agent_create");
    await handler({ _id: "plain-agent", name: "Plain", model: "haiku", homeBase: "agent-plain", roles: ["X"] });
    expect(agentDocsStore.get("plain-agent").floorCritical).toBe(false);
  });

  it("agent_update round-trips floorCritical", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = getHandler(makeTools(), "agent_update");
    const result = await handler({ agent_id: "existing-agent", fields: { floorCritical: true } });
    expect(result.isError).toBeUndefined();
    expect(agentDocsStore.get("existing-agent").floorCritical).toBe(true);

    await handler({ agent_id: "existing-agent", fields: { floorCritical: false } });
    expect(agentDocsStore.get("existing-agent").floorCritical).toBe(false);
  });

  it("agent_update coerces garbage floorCritical to strict false", async () => {
    agentDocsStore.set("existing-agent", makeBaseAgent());
    const handler = getHandler(makeTools(), "agent_update");
    await handler({ agent_id: "existing-agent", fields: { floorCritical: "yes" } });
    expect(agentDocsStore.get("existing-agent").floorCritical).toBe(false);
  });
});
```

- [ ] **Step 2.5:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/admin/admin-mcp-server.test.ts`
Expected: all tests pass, including 4 new `floorCritical write boundary` tests.

- [ ] **Step 2.6:** Commit

```bash
git add src/admin/admin-mcp-server.ts src/admin/admin-mcp-server.test.ts
git commit -m "KPR-308: admin MCP accepts, coerces, and surfaces floorCritical"
```

---

### Task 3: `WsAdapter.deliverBroadcast` + the structural seam

**Files:**
- Modify: `src/channels/channel-adapter.ts`
- Modify: `src/channels/ws/ws-adapter.ts` (new method after `deliver()`, ~`:393`)
- Test: `src/channels/ws/ws-adapter.test.ts`

- [ ] **Step 3.1:** In `src/channels/channel-adapter.ts`, append after the `ChannelAdapter` interface (file already imports `WorkResult`):

```typescript
/**
 * KPR-308: adapters that can broadcast a WorkResult to every currently
 * connected client, with no per-device routing. Used by the dispatcher's
 * outage-mode delivery preference for diverted items that carry no
 * meta.deviceId (scheduler/Slack-sourced agent output).
 *
 * Returns the number of connections the frame was delivered to — 0 means
 * "not delivered"; callers must fall through to their normal delivery path.
 */
export interface BroadcastCapableAdapter extends ChannelAdapter {
  deliverBroadcast(result: WorkResult): Promise<number>;
}

export function isBroadcastCapable(adapter: ChannelAdapter): adapter is BroadcastCapableAdapter {
  return typeof (adapter as Partial<BroadcastCapableAdapter>).deliverBroadcast === "function";
}
```

- [ ] **Step 3.2:** In `src/channels/ws/ws-adapter.ts`, add directly after the `deliver()` method:

```typescript
  /**
   * KPR-308: outage-mode broadcast delivery. Diverted agent-initiated items
   * (scheduler/Slack-sourced) carry no meta.deviceId, so deliver() cannot
   * route them; whoever is connected on the LAN during an outage *is* the
   * floor. Sends the standard message frame to every open connection and
   * returns the delivered count.
   *
   * Deliberately NO pendingMessages buffering (unlike deliver()) — an outage
   * notice queued for a device that reconnects next week is noise, and the
   * dispatcher's fall-through covers the zero-connections case.
   */
  async deliverBroadcast(result: WorkResult): Promise<number> {
    const text = result.error ? `Error: ${result.error}` : result.text;
    const agentName = this.agentRegistry.get(result.agentId)?.name ?? result.agentId;
    const msg: ServerMessage = {
      type: "message",
      text,
      agentId: result.agentId,
      agentName,
      replyTo: result.workItem.id,
    };

    let delivered = 0;
    for (const ws of this.connections.values()) {
      if (ws.readyState === WebSocket.OPEN) {
        this.send(ws, msg);
        delivered++;
      }
    }
    log.info("Broadcast delivery", { agentId: result.agentId, connections: delivered });
    return delivered;
  }
```

(No new imports needed: `WebSocket`, `ServerMessage`, `WorkResult`, and `log` are already in scope.)

- [ ] **Step 3.3:** In `src/channels/ws/ws-adapter.test.ts`, add a test group. No server startup needed — inject fake sockets straight into the private `connections` map (established pattern: tests already reach into `(adapter as any)` internals):

```typescript
describe("WsAdapter.deliverBroadcast (KPR-308)", () => {
  function makeResult(overrides: Record<string, any> = {}) {
    return {
      text: "outage update",
      agentId: "floor-agent",
      workItem: {
        id: "sched-1",
        text: "[Scheduled task]",
        source: { kind: "slack", id: "agent-floor", label: "agent-floor" },
        sender: "system",
        timestamp: new Date(),
        meta: { targetAgentId: "floor-agent" },
      },
      costUsd: 0,
      durationMs: 0,
      ...overrides,
    } as any;
  }

  function fakeSocket(readyState: number) {
    return { readyState, send: vi.fn() } as any;
  }

  it("sends the standard message frame to every open connection and returns the count", async () => {
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue({ name: "Floor Agent" }) },
      { getState: vi.fn(), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );
    const wsA = fakeSocket(1); // WebSocket.OPEN
    const wsB = fakeSocket(1);
    (adapter as any).connections.set("dev-a", wsA);
    (adapter as any).connections.set("dev-b", wsB);

    const count = await adapter.deliverBroadcast(makeResult());

    expect(count).toBe(2);
    for (const ws of [wsA, wsB]) {
      expect(ws.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(ws.send.mock.calls[0][0]);
      expect(frame).toMatchObject({
        type: "message",
        text: "outage update",
        agentId: "floor-agent",
        agentName: "Floor Agent",
        replyTo: "sched-1",
      });
    }
  });

  it("skips non-open sockets and does not count them", async () => {
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(undefined) },
      { getState: vi.fn(), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );
    const open = fakeSocket(1);
    const closed = fakeSocket(3); // WebSocket.CLOSED
    (adapter as any).connections.set("dev-open", open);
    (adapter as any).connections.set("dev-closed", closed);

    const count = await adapter.deliverBroadcast(makeResult());

    expect(count).toBe(1);
    expect(open.send).toHaveBeenCalledTimes(1);
    expect(closed.send).not.toHaveBeenCalled();
  });

  it("returns 0 with no connections and never touches pendingMessages", async () => {
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(undefined) },
      { getState: vi.fn(), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );

    const count = await adapter.deliverBroadcast(makeResult());

    expect(count).toBe(0);
    expect((adapter as any).pendingMessages.size).toBe(0);
  });

  it("falls back to agent id when the agent is missing from the registry", async () => {
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(undefined) },
      { getState: vi.fn(), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );
    const ws = fakeSocket(1);
    (adapter as any).connections.set("dev-a", ws);

    await adapter.deliverBroadcast(makeResult());

    expect(JSON.parse(ws.send.mock.calls[0][0]).agentName).toBe("floor-agent");
  });
});
```

Note: `makeAdapter` in this file passes the registry mock through — the calls above add a `get` mock alongside the existing `getAll`. If the file's `makeAdapter` signature drifted at HEAD, inline `new WsAdapter(3200, { ...noopTeamDeps(), agentRegistry, agentManager })` instead.

- [ ] **Step 3.4:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/ws/ws-adapter.test.ts`
Expected: all tests pass, including 4 new `deliverBroadcast` tests.

- [ ] **Step 3.5:** Commit

```bash
git add src/channels/channel-adapter.ts src/channels/ws/ws-adapter.ts src/channels/ws/ws-adapter.test.ts
git commit -m "KPR-308: WsAdapter.deliverBroadcast + BroadcastCapableAdapter seam"
```

---

### Task 4: Dispatcher outage-mode delivery preference behind the `OutageStateProvider` seam

**Files:**
- Modify: `src/channels/dispatcher.ts` (imports; class fields; two success-delivery blocks at ~`:228-235` and ~`:615-621`; new private methods)
- Test: `src/channels/dispatcher.test.ts`

- [ ] **Step 4.1:** Update the `ChannelAdapter` import at the top of `dispatcher.ts` to also pull the value-level guard:

```typescript
import type { ChannelAdapter } from "./channel-adapter.js";
import { isBroadcastCapable } from "./channel-adapter.js";
```

- [ ] **Step 4.2:** Add the exported seam type above the `Dispatcher` class (near `ResolvedAgent`):

```typescript
/**
 * KPR-308 §5.3: breaker dependency seam. `true` = outage mode active.
 * The dispatcher must NOT import KPR-306's breaker implementation — index.ts
 * wires whatever surface KPR-306 exports into this one-function seam, in a
 * later integration step. Until then the stub default keeps the slice dormant.
 */
export type OutageStateProvider = () => boolean;
```

- [ ] **Step 4.3:** Add the field and setter to the `Dispatcher` class (field near the other privates; setter next to `setRetryQueue`):

```typescript
  private outageStateProvider: OutageStateProvider = () => false;
```

```typescript
  setOutageStateProvider(fn: OutageStateProvider): void {
    this.outageStateProvider = fn;
  }
```

- [ ] **Step 4.4:** Add the two private methods (place after `convertTurnResult`):

```typescript
  /**
   * KPR-308 §5.2: outage-mode delivery preference. Applied at both agent-
   * response delivery sites before the source adapter is used. Diverts to a
   * WS broadcast only when ALL hold: the result carries no error; outage mode
   * active; the handling agent is floorCritical; the item is slack- or
   * scheduler-sourced (app/team/sms replies already route correctly and must
   * never divert); the ws adapter is registered and broadcast-capable; and at
   * least one device is connected (deliverBroadcast's returned count is the
   * authoritative check — no redundant connectionCount pre-check). Any
   * failure or zero-count falls through to the normal source-adapter path.
   *
   * The "scheduler" leg is defensive: ChannelKind includes it, but nothing
   * produces it today — the scheduler synthesizes kind:"slack" sources.
   */
  private async tryOutageDiversion(result: WorkResult): Promise<boolean> {
    // Review advisory: error-carrying results always deliver via the source
    // adapter — no error frames on the floor broadcast.
    if (result.error) return false;
    if (!this.outageStateProvider()) return false;
    const sourceKind = result.workItem.source.kind;
    if (sourceKind !== "slack" && sourceKind !== "scheduler") return false;
    if (this.registry.get(result.agentId)?.floorCritical !== true) return false;
    const wsAdapter = this.adapters.get("ws");
    if (!wsAdapter || !isBroadcastCapable(wsAdapter)) return false;

    try {
      const delivered = await wsAdapter.deliverBroadcast(result);
      if (delivered === 0) {
        log.info("Outage diversion: no connected devices, falling through", {
          agentId: result.agentId,
          sourceKind,
        });
        return false;
      }
      // Log-redaction convention: agent id, source kind, count — no message text.
      log.info("Outage diversion: delivered via app broadcast", {
        agentId: result.agentId,
        sourceKind,
        connections: delivered,
      });
      return true;
    } catch (err) {
      log.warn("Outage diversion: broadcast failed, falling through", {
        agentId: result.agentId,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * KPR-308: shared agent-response delivery for the two dispatch paths.
   * Diversion guard first; otherwise the pre-existing source-adapter
   * delivery with retry-queue semantics, unchanged.
   */
  private async deliverAgentResult(workResult: WorkResult, sourceAdapter: ChannelAdapter | undefined): Promise<void> {
    if (await this.tryOutageDiversion(workResult)) return;
    if (!sourceAdapter) return;
    try {
      await sourceAdapter.deliver(workResult);
    } catch (err) {
      log.warn("Agent response delivery failed, queuing for retry", { error: String(err) });
      this.retryQueue?.enqueue(workResult, sourceAdapter);
    }
  }
```

- [ ] **Step 4.5:** In `dispatch()` (step-4 success path), replace this block:

```typescript
        if (adapter) {
          try {
            await adapter.deliver(workResult);
          } catch (err) {
            log.warn("Agent response delivery failed, queuing for retry", { error: String(err) });
            this.retryQueue?.enqueue(workResult, adapter);
          }
        }
```

with:

```typescript
        await this.deliverAgentResult(workResult, adapter);
```

- [ ] **Step 4.6:** In `dispatchToAgent()` (fan-out success path), replace this block:

```typescript
        if (adapter) {
          try {
            await adapter.deliver(workResult);
          } catch (err) {
            this.retryQueue?.enqueue(workResult, adapter);
          }
        }
```

with:

```typescript
        await this.deliverAgentResult(workResult, adapter);
```

**Deliberately unchanged:** the status-query delivery, both error-result deliveries (`errorResult` catch blocks), and `onProcessingStart/End` stay on the source adapter — the spec's matrix covers agent responses only, and scheduler-synthesized items are a no-op in `SlackAdapter.onProcessingStart` (no `slackTs` in meta — citation C14), so the outage path reaches the turn and the delivery guard. Do not divert error results in this slice.

- [ ] **Step 4.7:** In `src/channels/dispatcher.test.ts`, add the matrix group. Extend `makeMockRegistry()`'s agents map with one entry (inside the existing helper, alongside the other `agents.set(...)` calls):

```typescript
  agents.set("floor-agent", {
    id: "floor-agent",
    name: "Floory",
    channels: ["agent-floor"],
    passiveChannels: [],
    keywords: [],
    homeBase: "agent-floor",
    isDefault: false,
    floorCritical: true,
  });
```

Then add the test group:

```typescript
// ---------------------------------------------------------------------------
// KPR-308 — outage-mode delivery preference
// ---------------------------------------------------------------------------

describe("outage-mode delivery preference (KPR-308)", () => {
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let healthReporter: ReturnType<typeof makeMockHealthReporter>;
  let slackAdapter: ReturnType<typeof makeMockAdapter>;
  let wsAdapter: ReturnType<typeof makeMockAdapter> & { deliverBroadcast: ReturnType<typeof vi.fn> };
  let dispatcher: Dispatcher;

  function makeSchedulerSynthItem(agentId = "floor-agent"): WorkItem {
    // Mirrors scheduler.ts synthesis: slack-kind source, meta.targetAgentId.
    return makeWorkItem({
      source: { kind: "slack", id: "agent-floor", label: "agent-floor" },
      sender: "system",
      threadId: `scheduler:${agentId}:task:${Date.now()}-${workItemCounter}`,
      meta: { targetAgentId: agentId },
    });
  }

  beforeEach(() => {
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    healthReporter = makeMockHealthReporter();
    slackAdapter = makeMockAdapter();
    wsAdapter = {
      ...makeMockAdapter(),
      id: "ws",
      kind: "app" as const,
      deliverBroadcast: vi.fn().mockResolvedValue(1),
    };
    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    dispatcher.registerAdapter(slackAdapter as any);
    dispatcher.registerAdapter(wsAdapter as any);
  });

  it("does not divert when the provider reports no outage (dormant default)", async () => {
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("diverts a floor-critical agent's slack-sourced item to the broadcast during an outage", async () => {
    dispatcher.setOutageStateProvider(() => true);
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(wsAdapter.deliverBroadcast).toHaveBeenCalledTimes(1);
    expect(wsAdapter.deliverBroadcast.mock.calls[0][0].agentId).toBe("floor-agent");
    expect(slackAdapter.deliver).not.toHaveBeenCalled();
  });

  it("diverts the defensive scheduler source kind (type-union branch; no live producer today)", async () => {
    dispatcher.setOutageStateProvider(() => true);
    const item = makeWorkItem({
      source: { kind: "scheduler", id: "agent-floor", label: "agent-floor" },
      meta: { targetAgentId: "floor-agent" },
    });
    await dispatcher.dispatch(item);
    expect(wsAdapter.deliverBroadcast).toHaveBeenCalledTimes(1);
  });

  it("does not divert non-floor-critical agents during an outage", async () => {
    dispatcher.setOutageStateProvider(() => true);
    await dispatcher.dispatch(makeSchedulerSynthItem("jasper"));
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("never diverts app-sourced replies (source-keyed round-trip untouched)", async () => {
    dispatcher.setOutageStateProvider(() => true);
    const item = makeWorkItem({
      source: { kind: "app", id: "dev-1", label: "app:Shop", adapterId: "ws" },
      meta: { targetAgentId: "floor-agent", deviceId: "dev-1" },
    });
    await dispatcher.dispatch(item);
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(wsAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("never diverts sms-sourced items (an SMS user is not on the shop floor)", async () => {
    dispatcher.setOutageStateProvider(() => true);
    const smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as const };
    dispatcher.registerAdapter(smsAdapter as any);
    const item = makeWorkItem({
      source: { kind: "sms", id: "+15550001111", label: "sms" },
      meta: { targetAgentId: "floor-agent" },
    });
    await dispatcher.dispatch(item);
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(smsAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("falls through to the source adapter when the broadcast reaches zero devices", async () => {
    dispatcher.setOutageStateProvider(() => true);
    wsAdapter.deliverBroadcast.mockResolvedValue(0);
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(wsAdapter.deliverBroadcast).toHaveBeenCalledTimes(1);
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("falls through to the source adapter when the broadcast throws", async () => {
    dispatcher.setOutageStateProvider(() => true);
    wsAdapter.deliverBroadcast.mockRejectedValue(new Error("boom"));
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("falls through when no ws adapter is registered", async () => {
    const bare = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    bare.registerAdapter(slackAdapter as any);
    bare.setOutageStateProvider(() => true);
    await bare.dispatch(makeSchedulerSynthItem());
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
  });

  it("existing retry-queue semantics survive the fall-through path", async () => {
    dispatcher.setOutageStateProvider(() => true);
    wsAdapter.deliverBroadcast.mockResolvedValue(0);
    slackAdapter.deliver.mockRejectedValue(new Error("slack down"));
    const retryQueue = { enqueue: vi.fn() };
    dispatcher.setRetryQueue(retryQueue as any);
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(retryQueue.enqueue).toHaveBeenCalledTimes(1);
  });

  it("never diverts a result carrying an error, even when every other condition holds (review advisory)", async () => {
    dispatcher.setOutageStateProvider(() => true);
    agentManager.runWorkItemTurn.mockResolvedValueOnce({
      finalMessage: "partial output before the failure",
      newSessionId: "s2",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 0,
        costUsd: 0.01,
        durationMs: 800,
      },
      errors: ["tool call failed"],
      llmMs: 0,
      toolMs: 0,
      toolCalls: 0,
      toolSummary: null,
      streamed: false,
      compactions: 0,
    });
    await dispatcher.dispatch(makeSchedulerSynthItem());
    expect(wsAdapter.deliverBroadcast).not.toHaveBeenCalled();
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
    expect(slackAdapter.deliver.mock.calls[0][0].error).toBe("tool call failed");
  });

  it("fan-out path (dispatchToAgent, site 2): floor-critical agent's reply diverts to broadcast, the other delivers normally", async () => {
    dispatcher.setOutageStateProvider(() => true);
    const item = makeWorkItem({ text: "Floory, and Jasper, coordinate on this" });
    await dispatcher.dispatch(item);
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    expect(wsAdapter.deliverBroadcast).toHaveBeenCalledTimes(1);
    expect(wsAdapter.deliverBroadcast.mock.calls[0][0].agentId).toBe("floor-agent");
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
    expect(slackAdapter.deliver.mock.calls[0][0].agentId).toBe("jasper");
  });
});

describe("BroadcastCapableAdapter seam contract (KPR-308)", () => {
  it("a real WsAdapter instance satisfies isBroadcastCapable; a bare mock does not", async () => {
    const { isBroadcastCapable } = await import("./channel-adapter.js");
    const { WsAdapter } = await import("./ws/ws-adapter.js");
    const real = new WsAdapter(0, {
      teamStore: {} as any,
      commandRegistry: {} as any,
      agentRegistry: { getAll: vi.fn().mockReturnValue([]), get: vi.fn() } as any,
      agentManager: { getState: vi.fn(), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) } as any,
    });
    expect(isBroadcastCapable(real)).toBe(true);
    expect(isBroadcastCapable(makeMockAdapter() as any)).toBe(false);
  });
});
```

- [ ] **Step 4.8:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts`
Expected: all tests pass, including 12 new outage-preference tests (10 dispatch()-path matrix cases + the error-guard case + the dispatchToAgent fan-out case) and the seam-contract test. Pre-existing dispatcher tests unchanged and green (dormancy invariant).

- [ ] **Step 4.9:** Commit

```bash
git add src/channels/dispatcher.ts src/channels/dispatcher.test.ts
git commit -m "KPR-308: dispatcher outage-mode delivery preference behind OutageStateProvider seam"
```

---

### Task 5: `agent_list` floorCritical exposure (spec §5.1 nice-to-have — trim on PR bloat)

**Files:**
- Modify: `src/channels/ws/protocol.ts` (`AgentInfo`, ~`:175-187`)
- Modify: `src/channels/ws/ws-adapter.ts` (`buildAgentList`, ~`:466-489`)
- Test: `src/channels/ws/ws-adapter.test.ts` (existing `buildAgentList` describe)

- [ ] **Step 5.1:** In `protocol.ts`, add to `AgentInfo` after `channels: string[];`:

```typescript
  /** KPR-308: badge for agents whose output diverts to the app during a WAN outage. */
  floorCritical: boolean;
```

- [ ] **Step 5.2:** In `buildAgentList()`, add to the returned object after `channels: agent.channels,`:

```typescript
        floorCritical: agent.floorCritical === true,
```

- [ ] **Step 5.3:** In the existing `WsAdapter.buildAgentList()` describe block, add:

```typescript
  it("exposes floorCritical, defaulting false", () => {
    const flagged = makeAgent({ id: "floor", floorCritical: true });
    const plain = makeAgent({ id: "plain" });
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([flagged, plain]) },
      { getState: vi.fn().mockReturnValue(undefined), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );
    const result = (adapter as any).buildAgentList();
    expect(result.find((a: any) => a.id === "floor").floorCritical).toBe(true);
    expect(result.find((a: any) => a.id === "plain").floorCritical).toBe(false);
  });
```

- [ ] **Step 5.4:** Verify

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/ws/ws-adapter.test.ts src/channels/ws/protocol.test.ts`
Expected: all tests pass, including the new exposure test.

- [ ] **Step 5.5:** Commit

```bash
git add src/channels/ws/protocol.ts src/channels/ws/ws-adapter.ts src/channels/ws/ws-adapter.test.ts
git commit -m "KPR-308: expose floorCritical in WS agent_list payload"
```

---

### Task 6: Dormant seam wiring in `index.ts` + full gate

**Files:**
- Modify: `src/index.ts` (after `dispatcher.setRetryQueue(retryQueue);`, ~`:735`)

- [ ] **Step 6.1:** Add directly after `dispatcher.setRetryQueue(retryQueue);`:

```typescript
  // KPR-308: outage-mode delivery-preference seam (spec §5.3). Explicitly
  // dormant — this call is the documented wiring point for KPR-306's
  // provider-circuit breaker. Replacing the stub with the breaker-state
  // surface KPR-306 exports (sync getter or cached snapshot — the seam
  // absorbs either) is a LATER integration step, possibly in KPR-306's or
  // KPR-307's lane, NOT part of the KPR-308 slice.
  dispatcher.setOutageStateProvider(() => false);
```

- [ ] **Step 6.2:** Full quality gate

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: typecheck + lint + format + full vitest suite all green, exit 0. If format complains, run `npm run format` and re-run the gate.

- [ ] **Step 6.3:** Commit

```bash
git add src/index.ts
git commit -m "KPR-308: wire dormant OutageStateProvider stub at the KPR-306 integration point"
```

---

### Task 7: Manual LAN verification checklist (verify-only — documented operator steps, NO code)

These are the spec's B-1/B-2/B-5 beekeeper reachability items (§4 option b + §7), scoped as **rollout verification, not code**. Record them in the PR description / ticket as the operator's pre-cutover checklist. The operator's D3 ruling accepted plain `ws://` on the shop LAN and the full public-surface exposure for W2; the deferred hardening is tracked as **KPR-333 (rate-limit `POST /pair`)** and **KPR-334 (TLS on LAN)** in beekeeper's lane.

- [ ] **V1 (B-1) — bind posture:** on the production mini: `lsof -nP -iTCP:8420 -sTCP:LISTEN` → expect the beekeeper node process bound to `*:8420` (all interfaces), not `127.0.0.1:8420`.
- [ ] **V2 (B-5) — host firewall:** confirm macOS application firewall / pf permits inbound :8420 from the LAN subnet (System Settings → Network → Firewall; `sudo pfctl -sr | grep -i 8420` should show no block rule). This was flagged **unverified** in the spec — it is the one genuinely unknown rollout item.
- [ ] **V3 — mDNS resolution:** from an iOS/laptop client on the shop Wi-Fi: resolve and ping `<mini-hostname>.local`. If the AP isolates clients or filters multicast, fall back to a static LAN IP / DHCP reservation (the app contract §6.5 supports manual entry).
- [ ] **V4 (B-1/B-2) — authenticated LAN session:** from the LAN client with a valid paired-device JWT: connect `ws://<mini-hostname>.local:8420/?token=<jwt>&channel=hive` (e.g. `websocat`), send `{"type":"agent_list","id":"t1"}` → expect an `agent_list` response (now including `floorCritical` badges, Task 5). This proves the tunnel-free path end to end.
- [ ] **V5 (B-2) — auth negative:** repeat V4 with a garbage/revoked token → expect the connection to be rejected. JWT verification must behave identically for LAN-originated connections.
- [ ] **V6 — hive trust boundary intact:** from the LAN client: `nc -vz <mini-hostname>.local <hive ws port, default 3200>` → expect refused/timeout. Hive's ws-adapter stays loopback-bound (C15); only beekeeper faces the LAN.
- [ ] **V7 — surface acknowledgment:** note in the rollout record that LAN exposure covers beekeeper's **entire** public HTTP surface including the unauthenticated `POST /pair` (no rate limit until KPR-333) — the operator D3 ruling blessed this full surface for W2.

---

## Execution Handoff

Plan saved to `docs/epics/kpr-305/kpr-308-plan.md`. After clean plan review + dependency check, apply `ready-to-implement` and execute via `dodi-dev:implement`. Commit-message trailer per repo convention: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.
