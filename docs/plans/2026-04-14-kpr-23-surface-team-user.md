# KPR-23: Surface server-asserted `user` from beekeeper team-channel handshake

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Read the server-asserted `user` identity and renamed `label` query params from beekeeper's loopback WS upgrade, carry them through `WorkItem.meta`, and surface the user to agents in their per-turn prompt.

**Architecture:** Beekeeper's team-proxy forwards WS frames to hive's loopback WS adapter, appending `?deviceId=&label=&user=[&origin=]` to the upgrade URL. Hive trusts those URL params (asserted after JWT verification upstream), ignores any `user` field inside forwarded frames, and threads the identity into the agent prompt via the existing sender-attribution prefix that slack- and sms-adapters already rely on.

**Tech Stack:** TypeScript, Node 24, `ws` library, Vitest.

**Spec:** KPR-23 (Linear). Wire contract from beekeeper PR #11: `?internal=1&deviceId=<uuid>&label=<cosmetic>&user=<server-asserted-id>[&origin=<slug>]`. Deployed beekeeper still sends `name=` — transitional `label ?? name` fallback required.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/channels/ws/ws-adapter.ts` (modify) | Upgrade handler reads `label`/`user`; `Device` struct carries both; team message/image/file handlers put `user` on `WorkItem.meta.user`; plain `message`/`image` app paths also get `user` on meta for uniformity. |
| `src/channels/ws/ws-adapter.test.ts` (modify) | Cover new `label`+`user` contract, `name` fallback, missing `user` (optional), missing-required rejection, frame-level `user` ignored, `meta.user` propagation. |
| `src/agents/agent-manager.ts` (modify) | Sender-attribution prefix includes `user:<id>` when `meta.user` is set, mirroring the existing `[senderName in #channel]: text` shape. |
| `src/agents/agent-manager.test.ts` (modify) | Assert prompt includes `user:` segment when `meta.user` is present and omits it when absent. |

---

## Task 1: Wire contract — URL params and `Device` rename in ws-adapter

**Files:**
- Modify: `src/channels/ws/ws-adapter.ts` (lines 35–40 `Device` struct, 127–140 upgrade handler, 146–148 log, 237–249 app-message WorkItem, 263–282 app-image WorkItem, 471–489 team-message WorkItem, 526–545 team-image WorkItem, 592–611 team-file WorkItem, 436–466 `handleTeamMessage` saveMessage, 506–522 image saveMessage, 572–588 file saveMessage, 624–651 `handleCommand` senderName)

- [ ] **Step 1:** Rename `Device.name` → `Device.label` and add optional `user`. Update the doc comment to match the new wire contract.

```typescript
/**
 * Synthetic device identity for the WS connection. Post-Phase-B, Hive's WS
 * adapter no longer owns a device registry — `@keepur/beekeeper` does. The
 * upgrade handler receives `deviceId`, `label` (cosmetic display name), and
 * `user` (server-asserted identity, JWT-verified upstream) as loopback query
 * params from the Beekeeper team proxy and builds this struct on the fly.
 * `user` is optional during the transition — older deployed beekeepers don't
 * emit it yet.
 */
interface Device {
  _id: string;
  label: string;
  user?: string;
  defaultAgentId: string;
  origin?: string;
}
```

- [ ] **Step 2:** In the upgrade handler, read `label` with a transitional `name` fallback and read optional `user`. Replace the current `deviceId`/`name` block (lines 127–133) and the synthetic-device construction (line 140).

```typescript
      const deviceId = url.searchParams.get("deviceId");
      // Transitional: deployed beekeeper still sends `name=`. Beekeeper PR #11
      // renamed it to `label=`. Accept either; remove the `name` fallback in a
      // follow-up once both sides are deployed.
      const label = url.searchParams.get("label") ?? url.searchParams.get("name");
      // Server-asserted identity from beekeeper (after JWT verification).
      // Optional during rollout — deployed beekeeper doesn't emit it yet.
      const user = url.searchParams.get("user") ?? undefined;
      if (!deviceId || !label) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      const origin = url.searchParams.get("origin") ?? undefined;

      // Synthetic device — loopback traffic comes from beekeeper's team proxy.
      // Routing on the app path uses meta.origin, populated below from the
      // connection-level origin tag that beekeeper forwards via query param.
      const device: Device = { _id: deviceId, label, user, defaultAgentId: "", origin };
```

- [ ] **Step 3:** Update the connection log (line 148) so the log key matches the new field name.

```typescript
      log.info("Device connected", { deviceId, label: device.label });
```

- [ ] **Step 4:** Replace every `device.name` read with `device.label`. There are 11 occurrences after Step 3 (lines 237, 241, 269, 273, 463, 481, 510, 536, 576, 602, 637 in the pre-edit file). In each spot the replacement is identical:

```typescript
// before
              label: `app:${device.name}`,
              senderName: device.name,
// after
              label: `app:${device.label}`,
              senderName: device.label,
```

Do the rename for all 11 sites. Use editor find-and-replace constrained to this file: `device.name` → `device.label`.

- [ ] **Step 5:** Add `user` to `WorkItem.meta` at every team build site (three: `handleTeamMessage`, `handleTeamImage`, `handleTeamFile`). Only team paths — app paths (plain `message`/`image`) are explicitly out of scope for this ticket.

In `handleTeamMessage` (was ~line 484), replace the `meta` block:

```typescript
      meta: {
        deviceId,
        channelId: msg.channelId,
        ...(device.user ? { user: device.user } : {}),
        ...(targetAgentId ? { targetAgentId } : { defaultAgentId: device.defaultAgentId }),
      },
```

Apply the same `...(device.user ? { user: device.user } : {})` insertion to the `meta` blocks in `handleTeamImage` (was ~line 540) and `handleTeamFile` (was ~line 606).

- [ ] **Step 6:** Defensively ignore any `user` inside forwarded frames. `parseClientMessage` is typed and already drops unknown fields, but add a single-line comment above the `handleTeamMessage` call in the message router (around line 219) so the invariant is visible:

```typescript
          // Team content messages (message/image/file with channelId).
          // Note: identity comes from `device.user` (URL-asserted upstream by
          // beekeeper JWT verification). Any `user` field inside the frame is
          // client-supplied and MUST be ignored — parseClientMessage drops it
          // via its typed schema.
          if (isTeamMessage(msg)) {
```

- [ ] **Step 7:** Verify typecheck.

Run: `npm run typecheck`
Expected: exit 0, no errors.

- [ ] **Step 8:** Commit.

```bash
git add src/channels/ws/ws-adapter.ts
git commit -m "feat(ws-adapter): read label/user from upgrade URL, plumb user into team meta (KPR-23)"
```

---

## Task 2: ws-adapter tests — contract, fallback, and meta propagation

**Files:**
- Modify: `src/channels/ws/ws-adapter.test.ts` — existing upgrade-handler tests reference `name=` and `.name` on the emitted Device; update those to `label=`/`.label`, then add new cases.

- [ ] **Step 1:** Update existing upgrade tests to the new field name. Four tests touch `device.name` / `?name=`:
  - `"accepts internal=1 from ::ffff:127.0.0.1 and surfaces deviceId/name"` (lines 233–270)
  - `"rejects internal=1 from non-loopback with 403"` (lines 272–286)
  - `"upgrade with ?origin=dodi-shop surfaces origin on synthetic Device"` (lines 288–316)
  - `"upgrade without origin leaves device.origin undefined"` (lines 318–344)

For each, the mechanical change is: test URLs keep `&name=...` **only for the one "transitional fallback" test added in Step 3** — for all other tests, replace `&name=` with `&label=` in the request URL, and replace `expect(emittedDevices[0].name).toBe(...)` with `expect(emittedDevices[0].label).toBe(...)`.

Also rename the first test:

```typescript
  it("accepts internal=1 from ::ffff:127.0.0.1 and surfaces deviceId/label", async () => {
```

Update its URL and assertions:

```typescript
    const req: any = {
      url: "/?internal=1&deviceId=bk-abc&label=beekeeper",
      headers: {},
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };
    // ...
    expect(emittedDevices[0]._id).toBe("bk-abc");
    expect(emittedDevices[0].label).toBe("beekeeper");
    expect(emittedDevices[0].user).toBeUndefined();
    expect(emittedDevices[0].defaultAgentId).toBe("");
```

Apply the same `&label=` / `.label` fix to the origin tests (lines 288–344) and the rejection test URL (lines 272–286).

- [ ] **Step 2:** Update the two "emits WorkItem with meta.origin" tests (lines 346–416) to construct the fake device with `label` instead of `name`:

```typescript
    const device = { _id: "dev1", label: "Shop", defaultAgentId: "", origin: "dodi-shop" };
```

- [ ] **Step 3:** Add a new test for the `label ?? name` transitional fallback. Insert after the "surfaces deviceId/label" test.

```typescript
  it("accepts transitional ?name= fallback when ?label= is absent", async () => {
    const a = await startAdapter();

    const wss = (a as any).wss;
    vi.spyOn(wss, "handleUpgrade").mockImplementation(((_req: any, _socket: any, _head: any, cb: any) => {
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
      url: "/?internal=1&deviceId=bk-abc&name=beekeeper",
      headers: {},
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };
    const socket = makeFakeSocket("::ffff:127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(socket.destroyed).toBe(false);
    expect(emittedDevices).toHaveLength(1);
    expect(emittedDevices[0].label).toBe("beekeeper");
  });
```

- [ ] **Step 4:** Add a test for the `user` URL param being surfaced on the Device struct.

```typescript
  it("surfaces server-asserted ?user= on the synthetic Device", async () => {
    const a = await startAdapter();

    const wss = (a as any).wss;
    vi.spyOn(wss, "handleUpgrade").mockImplementation(((_req: any, _socket: any, _head: any, cb: any) => {
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
      url: "/?internal=1&deviceId=dev1&label=Shop&user=may-keepur",
      headers: {},
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };
    const socket = makeFakeSocket("::ffff:127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(emittedDevices).toHaveLength(1);
    expect(emittedDevices[0].user).toBe("may-keepur");
  });
```

- [ ] **Step 5:** Add a rejection test for missing `deviceId`/`label`/`name`.

```typescript
  it("rejects upgrade with deviceId but no label or name with 400", async () => {
    const a = await startAdapter();

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?internal=1&deviceId=bk-abc",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    };
    const socket = makeFakeSocket("127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(socket.destroyed).toBe(true);
    expect(socket.writtenChunks.join("")).toContain("400 Bad Request");
  });
```

- [ ] **Step 6:** Add a test that team message handlers propagate `device.user` to `WorkItem.meta.user`. Add a new `describe` block after the existing upgrade handler tests.

```typescript
describe("WsAdapter team meta.user propagation (KPR-23)", () => {
  let adapter: WsAdapter | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = undefined;
    }
  });

  it("puts device.user on WorkItem.meta.user for team messages", async () => {
    const teamDeps = noopTeamDeps();
    (teamDeps.teamStore.getChannel as any).mockResolvedValue({
      _id: "c1",
      type: "channel",
      name: "general",
      members: ["dev1"],
    });

    adapter = new WsAdapter(0, {
      ...teamDeps,
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
    });

    const captured: any[] = [];
    await adapter.start((item) => captured.push(item));

    const device = { _id: "dev1", label: "Shop", user: "may-keepur", defaultAgentId: "", origin: undefined };
    const wss = (adapter as any).wss;
    const fakeWs = new EventEmitter() as any;
    fakeWs.close = vi.fn();
    fakeWs.send = vi.fn();
    wss.emit("connection", fakeWs, {} as any, device);

    fakeWs.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "message", id: "m1", channelId: "c1", text: "hi team" })),
    );
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].meta?.user).toBe("may-keepur");
    expect(captured[0].meta?.channelId).toBe("c1");
  });

  it("omits meta.user when device.user is undefined (transitional beekeeper)", async () => {
    const teamDeps = noopTeamDeps();
    (teamDeps.teamStore.getChannel as any).mockResolvedValue({
      _id: "c1",
      type: "channel",
      name: "general",
      members: ["dev1"],
    });

    adapter = new WsAdapter(0, {
      ...teamDeps,
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
    });

    const captured: any[] = [];
    await adapter.start((item) => captured.push(item));

    const device = { _id: "dev1", label: "Shop", user: undefined, defaultAgentId: "", origin: undefined };
    const wss = (adapter as any).wss;
    const fakeWs = new EventEmitter() as any;
    fakeWs.close = vi.fn();
    fakeWs.send = vi.fn();
    wss.emit("connection", fakeWs, {} as any, device);

    fakeWs.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "message", id: "m1", channelId: "c1", text: "hi team" })),
    );
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].meta?.user).toBeUndefined();
  });

  it("ignores client-supplied `user` inside forwarded frames", async () => {
    const teamDeps = noopTeamDeps();
    (teamDeps.teamStore.getChannel as any).mockResolvedValue({
      _id: "c1",
      type: "channel",
      name: "general",
      members: ["dev1"],
    });

    adapter = new WsAdapter(0, {
      ...teamDeps,
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
    });

    const captured: any[] = [];
    await adapter.start((item) => captured.push(item));

    const device = { _id: "dev1", label: "Shop", user: "may-keepur", defaultAgentId: "", origin: undefined };
    const wss = (adapter as any).wss;
    const fakeWs = new EventEmitter() as any;
    fakeWs.close = vi.fn();
    fakeWs.send = vi.fn();
    wss.emit("connection", fakeWs, {} as any, device);

    // Frame carries a rogue `user` field — must be dropped.
    fakeWs.emit(
      "message",
      Buffer.from(
        JSON.stringify({ type: "message", id: "m1", channelId: "c1", text: "hi", user: "attacker" }),
      ),
    );
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].meta?.user).toBe("may-keepur");
  });
});
```

- [ ] **Step 7:** Run ws-adapter tests in isolation.

Run: `npx vitest run src/channels/ws/ws-adapter.test.ts`
Expected: all tests pass, new `(KPR-23)` block green.

- [ ] **Step 8:** Commit.

```bash
git add src/channels/ws/ws-adapter.test.ts
git commit -m "test(ws-adapter): cover KPR-23 label/user contract and meta propagation"
```

---

## Task 3: Surface `meta.user` in the agent prompt prefix

**Files:**
- Modify: `src/agents/agent-manager.ts:162-167` — sender-attribution prefix construction.

- [ ] **Step 1:** Extend the prompt prefix to include `user:<id>` when `meta.user` is set. Match the existing `[senderName in #channelLabel]: text` shape — parenthetical user id only when present, so slack/sms paths (which never set `meta.user`) are unchanged.

Replace the current block:

```typescript
        // Prepend sender identity so the agent knows who they're talking to
        const senderLabel = item.message.senderName ?? item.message.sender;
        let prompt = item.message.senderName
          ? `[${senderLabel} in #${item.message.source.label}]: ${item.message.text}`
          : item.message.text;
```

With:

```typescript
        // Prepend sender identity so the agent knows who they're talking to.
        // For team channel (KPR-23): `meta.user` is the server-asserted
        // identity forwarded by beekeeper after JWT verification. When set,
        // surface it so agents treat it as "the user I'm talking with,"
        // distinct from the cosmetic device label.
        const senderLabel = item.message.senderName ?? item.message.sender;
        const userId = item.message.meta?.user as string | undefined;
        let prompt: string;
        if (userId) {
          prompt = `[user:${userId} via ${senderLabel} in #${item.message.source.label}]: ${item.message.text}`;
        } else if (item.message.senderName) {
          prompt = `[${senderLabel} in #${item.message.source.label}]: ${item.message.text}`;
        } else {
          prompt = item.message.text;
        }
```

- [ ] **Step 2:** Verify typecheck.

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3:** Commit.

```bash
git add src/agents/agent-manager.ts
git commit -m "feat(agent-manager): surface meta.user in prompt prefix (KPR-23)"
```

---

## Task 4: agent-manager prompt-prefix test

**Files:**
- Modify: `src/agents/agent-manager.test.ts` — add assertions that the prompt prefix includes `user:<id>` when `meta.user` is set and omits it otherwise.

- [ ] **Step 1:** Locate the existing test that already asserts on the prompt prefix. Around line 518 there is a test that exercises `senderName: "Alice"`; find the nearest `describe` that dispatches a message through agent-manager and captures the prompt passed to `runner.send`. If no existing test captures the prompt directly, add a new test in the same describe block that spies on `AgentRunner.prototype.send`.

Run: `npx vitest run src/agents/agent-manager.test.ts -t "senderName"` and skim the output to find the right anchor.

- [ ] **Step 2:** Add two new tests in the same describe block. The shape mirrors whatever pattern already spies on `runner.send` — if the existing test uses `vi.spyOn(AgentRunner.prototype, "send")`, reuse it; otherwise use `vi.mock("./agent-runner.js", ...)` following the local convention.

```typescript
  it("includes user:<id> in prompt prefix when meta.user is set (KPR-23)", async () => {
    // Follow the same setup as the existing senderName test above — capture
    // the `prompt` argument passed to `runner.send` when a WorkItem with
    // meta.user is dispatched, then assert on its shape.
    const capturedPrompt = await dispatchAndCapturePrompt({
      id: "m1",
      text: "hey",
      source: { kind: "team", id: "c1", label: "general", adapterId: "ws" },
      sender: "dev1",
      senderName: "Shop",
      threadId: "team:c1",
      timestamp: new Date(),
      meta: { deviceId: "dev1", channelId: "c1", user: "may-keepur" },
    });

    expect(capturedPrompt).toBe("[user:may-keepur via Shop in #general]: hey");
  });

  it("omits user: segment when meta.user is absent (KPR-23)", async () => {
    const capturedPrompt = await dispatchAndCapturePrompt({
      id: "m2",
      text: "hey",
      source: { kind: "team", id: "c1", label: "general", adapterId: "ws" },
      sender: "dev1",
      senderName: "Shop",
      threadId: "team:c1",
      timestamp: new Date(),
      meta: { deviceId: "dev1", channelId: "c1" },
    });

    expect(capturedPrompt).toBe("[Shop in #general]: hey");
  });
```

`dispatchAndCapturePrompt` is shorthand for whatever the existing test harness already does — reuse it verbatim. If no helper exists, inline the spy/mocks directly following the nearest existing test's structure. **Do not invent a new harness.**

- [ ] **Step 3:** Run the agent-manager tests.

Run: `npx vitest run src/agents/agent-manager.test.ts`
Expected: all tests pass including the two new `(KPR-23)` cases.

- [ ] **Step 4:** Commit.

```bash
git add src/agents/agent-manager.test.ts
git commit -m "test(agent-manager): assert meta.user surfaces in prompt prefix"
```

---

## Task 5: File the follow-up and close the loop

- [ ] **Step 1:** Run the full quality gate.

Run: `npm run check`
Expected: typecheck + lint + format + test all green.

- [ ] **Step 2:** File a follow-up Linear ticket (via `mcp__plugin_linear_linear__save_issue`) to rip out the transitional `name` fallback once both hive and beekeeper deploys have flipped to the new contract. Title: "Hive: remove transitional `name` query param fallback from ws-adapter". Body points at KPR-23 and the exact call site (`src/channels/ws/ws-adapter.ts` — the `label ?? name` line added in Task 1 Step 2).

- [x] **Step 3:** Follow-up: KPR-26 (`Hive: remove transitional name query param fallback from ws-adapter`).

---

## Acceptance mapping

| Spec bullet | Covered by |
|---|---|
| Hive reads `user` from upstream team-channel URL → `WorkItem.meta.user` | Task 1 Steps 2, 5; Task 2 Steps 4, 6 |
| Reads `label` with `name` fallback, marked for removal | Task 1 Step 2 (comment); Task 2 Step 3; Task 5 Step 2 |
| Agent prompts surface `user` identity matching channel conventions | Task 3; Task 4 |
| Frame-level `user` ignored | Task 1 Step 6 (invariant comment); Task 2 Step 6 (test) |
| Tests for new contract, fallback, missing `user`, missing required | Task 2 Steps 1, 3, 4, 5 |
| Follow-up filed | Task 5 Step 2 |

## Out of scope (do not implement)

- Beekeeper-side changes (KPR-21, merged).
- iOS changes.
- Routing, permissions, or memory scoping by `user`.
- Any field rename on the `app`-source (plain `message`/`image`) paths beyond the mechanical `device.name` → `device.label` rename required by Step 4 of Task 1.
