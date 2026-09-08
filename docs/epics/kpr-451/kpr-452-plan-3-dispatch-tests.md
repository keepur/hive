# KPR-452 plan — chunk 3: dispatch-path integration tests

Read with [the main plan](kpr-452-plan.md). Tasks 5–6.

## Task 5: Dispatcher integration tests (AC1–AC8, AC10, AC13)

**Files:**
- Modify: `src/channels/dispatcher.test.ts:1071-1145` — replace the entire `describe("per-agent audit routing")` block.

All three of its existing tests assert homeBase behavior that no longer exists, so the block is **replaced**, not extended.

- [ ] **Step 1:** Add `afterEach` to the vitest import at `src/channels/dispatcher.test.ts:1` if it is not already there.

- [ ] **Step 2:** Replace `src/channels/dispatcher.test.ts:1071-1145` with the block below. The mock registry's `production-support` agent has `homeBase: "agent-sige"`, and the fixture channel map deliberately **contains** `agent-sige → C-SIGE` — that is what makes the AC6 assertion discriminating rather than vacuous.

```typescript
// ---------------------------------------------------------------------------
// KPR-452: audit routing. homeBase is no longer an audit destination; every
// surviving copy goes to the one configured audit channel.
// ---------------------------------------------------------------------------

describe("audit routing (KPR-452)", () => {
  let dispatcher: Dispatcher;
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let slackAdapter: ReturnType<typeof makeMockAdapter>;
  let wsAdapter: ReturnType<typeof makeMockAdapter>;
  let smsAdapter: ReturnType<typeof makeMockAdapter>;
  let listChannels: ReturnType<typeof vi.fn>;
  let nowMs: number;

  // The channel map deliberately CONTAINS the homeBase entries. AC6 is only
  // discriminating if a homeBase read would have succeeded.
  const CHANNELS = () =>
    new Map([
      ["agent-sige", "C-SIGE"],
      ["agent-jessica", "C-JESSICA"],
      ["ops-audit", "C-OPS"],
    ]);

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    nowMs = 1_000_000;
    vi.spyOn(Date, "now").mockImplementation(() => nowMs);
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    const healthReporter = makeMockHealthReporter();
    slackAdapter = makeMockAdapter();
    wsAdapter = { ...makeMockAdapter(), id: "ws", kind: "app" as any };
    smsAdapter = { ...makeMockAdapter(), id: "sms", kind: "sms" as any };
    listChannels = vi.fn().mockResolvedValue({ channels: [{ name: "late-audit", id: "C-LATE" }] });
    dispatcher = new Dispatcher(registry as any, agentManager as any, healthReporter as any, "executive-assistant");
    dispatcher.registerAdapter(slackAdapter as any);
    dispatcher.registerAdapter(wsAdapter as any);
    dispatcher.registerAdapter(smsAdapter as any);
    dispatcher.setSlackAdapter({ client: { conversations: { list: listChannels } } } as any);
  });

  afterEach(() => vi.restoreAllMocks());

  function wire(name: string | undefined, channels = CHANNELS()) {
    dispatcher.setAuditChannel(slackAdapter as any, channels);
    dispatcher.setAuditChannelName(name);
  }

  const auditCalls = () =>
    slackAdapter.deliver.mock.calls.filter((c: any[]) => c[0]?.workItem?.source?.label === "audit");
  const auditCall = () => auditCalls()[0];

  function internalItem(id: string) {
    return makeWorkItem({
      id,
      source: { kind: "internal", id: "team-chan-1", label: "team" },
      sender: "jasper",
      text: "peer ping",
      meta: { targetAgentId: "production-support" },
    });
  }

  // AC1 — the ops stream, single-dispatch site.
  it.each([
    ["team- agent→agent DM", "team-abc"],
    ["event: bus delivery", "event:evt-1:production-support"],
  ])("AC1: posts one copy of an internal %s to the audit channel", async (_label, id) => {
    wire("ops-audit");
    await dispatcher.dispatch(internalItem(id));
    expect(auditCalls()).toHaveLength(1);
    expect(auditCall()[0].workItem.source.id).toBe("C-OPS");
  });

  it("AC1: never posts to a homeBase channel even though it resolves", async () => {
    wire("ops-audit");
    await dispatcher.dispatch(internalItem("team-abc"));
    const targets = slackAdapter.deliver.mock.calls.map((c: any[]) => c[0]?.workItem?.source?.id);
    expect(targets).not.toContain("C-SIGE");
  });

  // AC2 — policy-skip on a non-Slack source kind.
  it("AC2: posts no copy for a sched: item on a non-Slack kind", async () => {
    wire("ops-audit");
    await dispatcher.dispatch(
      makeWorkItem({
        id: "sched:daily-brief",
        source: { kind: "sms", id: "PN_X", label: "quo-may", adapterId: "sms" },
        sender: "system",
        meta: { targetAgentId: "production-support" },
      }),
    );
    expect(auditCalls()).toHaveLength(0);
  });

  // AC3 — the Gate 1 boundary. Explicit, not implied.
  it.each([
    ["human slack message", "1788764967.970169", "user1"],
    ["cron item (kind slack, sender system)", "sched:daily-brief", "system"],
    ["slack-sourced callback item", "callback:cb-1", "system"],
  ])("AC3: %s posts no audit copy and its own delivery is unchanged", async (_label, id, sender) => {
    wire("ops-audit");
    const item = makeWorkItem({
      id,
      source: { kind: "slack", id: "C-HOME", label: "agent-sige" },
      sender,
      text: "do the thing",
      meta: { targetAgentId: "production-support", slackTs: "100.2", slackThreadTs: "100.1" },
    });
    await dispatcher.dispatch(item);
    expect(auditCalls()).toHaveLength(0);
    // The turn's own delivery is untouched: same adapter, same WorkItem
    // object, same text, thread metadata intact.
    expect(slackAdapter.deliver).toHaveBeenCalledTimes(1);
    const delivered = slackAdapter.deliver.mock.calls[0][0];
    expect(delivered.workItem).toBe(item);
    expect(delivered.agentId).toBe("production-support");
    expect(delivered.text).toBe("turn response");
    expect(delivered.workItem.meta.slackThreadTs).toBe("100.1");
  });

  // AC4 — the one class where "callback" and "audit copy" genuinely overlap.
  it("AC4: a callback: item sourced from SMS produces exactly one audit copy", async () => {
    wire("ops-audit");
    await dispatcher.dispatch(
      makeWorkItem({
        id: "callback:cb-2",
        source: { kind: "sms", id: "PN_X", label: "quo-may", adapterId: "sms" },
        sender: "system",
        meta: { targetAgentId: "production-support" },
      }),
    );
    expect(auditCalls()).toHaveLength(1);
    expect(auditCall()[0].workItem.source.id).toBe("C-OPS");
  });

  // AC5 — notify-class non-Slack turns, including the fire-and-forget voice
  // site and its non-fatality.
  it("AC5: a team(ws) item produces one copy in the audit channel", async () => {
    wire("ops-audit");
    await dispatcher.dispatch(
      makeWorkItem({
        source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
        text: "hi",
        meta: { origin: "dodi-shop", deviceId: "dev1" },
      }),
    );
    expect(auditCalls()).toHaveLength(1);
    expect(auditCall()[0].workItem.source.id).toBe("C-OPS");
  });

  // ⚠ Both audit assertions below MUST go through `vi.waitFor`. The voice
  // site is fire-and-forget: `routeVoiceTurn` resolves without awaiting
  // `postAuditLog`, and `postAuditLog` now takes at least one await
  // (`resolveAuditChannelId`) before `deliver` and another before its catch.
  // Traced microtask order for the rejecting leg: postAuditLog's resume is
  // queued BEFORE the test's own `await` continuation, but the deliver
  // REJECTION handler is queued AFTER it — so a bare
  // `expect(mockLogWarn).toHaveBeenCalledWith("Audit post failed", …)` runs
  // before the catch and fails every time. The `toHaveLength(1)` assertion
  // happens to pass today on a one-tick margin and breaks the moment another
  // await is added ahead of `deliver`. `vi.waitFor` is already this file's
  // idiom for exactly this shape — the pre-existing KPR-307 outage-interception
  // and KPR-402 continuation assertions use it throughout (12 call sites today);
  // the AC10 race test below is a new one, not the precedent.
  it("AC5: a voice turn produces one copy, and a rejected audit post never fails it", async () => {
    wire("ops-audit");
    const voiceItem = makeWorkItem({
      id: "vapi-call-1",
      source: { kind: "voice", id: "call-1", label: "voice", adapterId: "voice" },
      sender: "+15550001",
    });
    const ctx = {
      agentId: "production-support",
      sessionId: undefined,
      channelId: "call-1",
      threadId: "call-1",
      workItem: voiceItem,
      channel: "voice",
    };
    const ok = await dispatcher.routeVoiceTurn(ctx as any);
    expect(ok.finalMessage).toBe("turn response");
    await vi.waitFor(() => expect(auditCalls()).toHaveLength(1));
    expect(auditCall()[0].workItem.source.id).toBe("C-OPS");

    slackAdapter.deliver.mockRejectedValueOnce(new Error("slack 429"));
    const still = await dispatcher.routeVoiceTurn(ctx as any);
    expect(still.finalMessage).toBe("turn response");
    await vi.waitFor(() =>
      expect(mockLogWarn).toHaveBeenCalledWith(
        "Audit post failed",
        expect.objectContaining({ error: expect.any(String) }),
      ),
    );
  });

  // AC6 — no configured channel ⇒ mirror off, one warn, and NO homeBase read.
  it("AC6: with no configured channel nothing posts, one warn fires, homeBase is never used", async () => {
    wire(undefined);
    await dispatcher.dispatch(internalItem("team-abc"));
    expect(auditCalls()).toHaveLength(0);
    // The map contains agent-sige → C-SIGE, so a homeBase lookup would have
    // succeeded. Nothing was addressed there.
    const targets = slackAdapter.deliver.mock.calls.map((c: any[]) => c[0]?.workItem?.source?.id);
    expect(targets).not.toContain("C-SIGE");
    expect(mockLogWarn).toHaveBeenCalledWith(
      "No audit channel resolved",
      expect.objectContaining({ agentId: "production-support", auditChannel: null }),
    );
    expect(listChannels).not.toHaveBeenCalled();
  });

  // AC7 — no cross-channel thread metadata.
  it("AC7: audit copies carry no slackThreadTs/slackTs", async () => {
    wire("ops-audit");
    const item = internalItem("team-abc");
    item.meta = { ...item.meta, slackTs: "100.2", slackThreadTs: "100.1" };
    await dispatcher.dispatch(item);
    const copy = auditCall()[0].workItem;
    expect(copy.meta?.slackThreadTs).toBeUndefined();
    expect(copy.meta?.slackTs).toBeUndefined();
  });

  // AC8 — a runtime repoint applies on the next audit post, no restart.
  it("AC8: setAuditChannelName repoints the very next audit post", async () => {
    const channels = CHANNELS();
    wire("ops-audit", channels);
    await dispatcher.dispatch(internalItem("team-1"));
    expect(auditCalls()).toHaveLength(1);
    channels.set("ops-audit-2", "C-OPS2");
    dispatcher.setAuditChannelName("ops-audit-2");
    await dispatcher.dispatch(internalItem("team-2"));
    expect(auditCalls().map((c: any[]) => c[0].workItem.source.id)).toEqual(["C-OPS", "C-OPS2"]);
    expect(dispatcher.peekAuditChannelId()).toBe("C-OPS2");
  });

  // AC10 — the lazy refresh.
  it("AC10: refreshes on a miss, one page, no cursor, at most once per 60s", async () => {
    wire("late-audit");
    await dispatcher.dispatch(internalItem("team-1"));
    expect(listChannels).toHaveBeenCalledTimes(1);
    expect(listChannels.mock.calls[0][0]).toEqual({ types: "public_channel,private_channel", limit: 1000 });
    // NOT redundant with the toEqual above, and not to be deleted as such:
    // vitest's `toEqual` ignores undefined-valued keys, so a regression to
    // `{ types, limit, cursor }` with `cursor === undefined` would still pass
    // it. `toHaveProperty` is key-existence, so this line is the one that
    // actually pins "the cursor parameter is not threaded through".
    expect(listChannels.mock.calls[0][0]).not.toHaveProperty("cursor");
    expect(auditCall()[0].workItem.source.id).toBe("C-LATE");

    // Second miss inside the window: no second call.
    dispatcher.setAuditChannelName("never-there");
    nowMs += 59_000;
    await dispatcher.dispatch(internalItem("team-2"));
    expect(listChannels).toHaveBeenCalledTimes(1);

    // Past the window: one more.
    nowMs += 2_000;
    await dispatcher.dispatch(internalItem("team-3"));
    expect(listChannels).toHaveBeenCalledTimes(2);
  });

  it("AC10: a concurrent fan-out of audit posts issues exactly one refresh", async () => {
    wire("late-audit");
    let release: (() => void) | undefined;
    listChannels.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ channels: [{ name: "late-audit", id: "C-LATE" }] });
        }),
    );
    const races = [
      dispatcher.dispatch(internalItem("team-1")),
      dispatcher.dispatch(internalItem("team-2")),
      dispatcher.dispatch(internalItem("team-3")),
    ];
    await vi.waitFor(() => expect(release).toBeDefined());
    release!();
    await Promise.all(races);
    expect(listChannels).toHaveBeenCalledTimes(1);
    expect(auditCalls()).toHaveLength(3);
  });

  it("AC10: no refresh is attempted when the Slack adapter is unset", async () => {
    const bare = new Dispatcher(
      registry as any,
      agentManager as any,
      makeMockHealthReporter() as any,
      "executive-assistant",
    );
    bare.registerAdapter(slackAdapter as any);
    bare.setAuditChannel(slackAdapter as any, CHANNELS());
    bare.setAuditChannelName("late-audit");
    await bare.dispatch(internalItem("team-1"));
    expect(listChannels).not.toHaveBeenCalled();
    expect(auditCalls()).toHaveLength(0);
    expect(bare.auditRoutingReady()).toBe(false);
  });

  // AC13 — the audit path cannot fail an already-delivered turn.
  //
  // ⚠ The fixture is a ws/app item, NOT `internalItem`, and that choice is
  // what makes the two absence assertions mean anything. An `internal` item
  // resolves no adapter (none is registered for kind `internal`), so BOTH
  // `deliverAgentResult` (`if (!sourceAdapter) return;`) and
  // `handleTurnFailure` (`if (adapter) { … }`) early-return: no "Something
  // went wrong" text could reach `slackAdapter` no matter what the code under
  // test did, and the assertion would pass against a broken implementation.
  // With a ws/app item the delivery adapter is `wsAdapter` while the AUDIT
  // adapter is `slackAdapter`, so the two are separable: only the audit copy
  // is made to fail, and a containment break would show up as a real failure
  // notice on `wsAdapter`. (`outageStore.enqueue` stays a belt-and-braces
  // assertion — it is reachable only via `ProviderCircuitOpenError`, never
  // from a thrown audit fault — and is kept because AC13 names it.) This is
  // the same shape Task 6 uses at the fan-out site.
  function appItem() {
    return makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "hi",
      meta: { origin: "dodi-shop", deviceId: "dev1" },
    });
  }

  // The THIRD tuple element is the warn each row must actually reach, and it
  // is what makes the rows discriminating. Row 1 never reaches `deliver` at
  // all — the rejecting refresh leaves the name unresolved, so the only
  // fault-path warn is the refresh one — while row 2 resolves and fails in
  // `deliver`. A shared `"Audit post failed" || "Audit channel refresh failed"`
  // disjunction would pass on either row regardless of which fault the
  // arrangement actually produced.
  it.each([
    [
      "conversations.list rejects",
      () => {
        listChannels.mockRejectedValue(new Error("slack 429"));
        return "late-audit"; // not in CHANNELS() ⇒ forces the refresh path
      },
      "Audit channel refresh failed",
    ],
    [
      "auditAdapter.deliver rejects",
      () => {
        // Only the AUDIT adapter fails. wsAdapter.deliver — the turn's own
        // delivery — is untouched, so its call list is a real observation.
        slackAdapter.deliver.mockRejectedValue(new Error("slack transport reset"));
        return "ops-audit"; // resolves from the map ⇒ reaches deliver
      },
      "Audit post failed",
    ],
  ])("AC13: single-dispatch site survives when %s", async (_label, arrange, expectedWarn) => {
    const outageStore = { enqueue: vi.fn(), release: vi.fn(), markDone: vi.fn() };
    dispatcher.setOutageHandling({
      store: outageStore,
      config: { enabled: true, replayIntervalMs: 15_000, maxAgeHours: 4, maxDepth: 500, maxReplayAttempts: 3 },
      tracker: new OutageEpisodeTracker(),
    } as any);
    wire(arrange());
    await dispatcher.dispatch(appItem());

    // The turn's own delivery stands and handleTurnFailure was never entered:
    // exactly one ws delivery, and it is the agent's answer, not a notice.
    const texts = wsAdapter.deliver.mock.calls.map((c: any[]) => String(c[0]?.text ?? ""));
    expect(texts).toEqual(["turn response"]);
    // Strictly implied by the toEqual above — KEPT AS DOCUMENTATION, because
    // AC13 names the failure notice by its text and a reader scanning for
    // "Something went wrong" should find the assertion that forbids it. Do not
    // read it as independent coverage.
    expect(texts.some((t: string) => t.startsWith("Something went wrong"))).toBe(false);
    expect(outageStore.enqueue).not.toHaveBeenCalled();
    expect(mockLogWarn.mock.calls.some((c: any[]) => c[0] === expectedWarn)).toBe(true);
    expect(mockLogInfo).toHaveBeenCalledWith(
      "Work item dispatched",
      expect.objectContaining({ agentId: "production-support" }),
    );
  });
});
```

- [ ] **Step 3:** Verify.

```bash
cd /Users/mokie/github/hive-kpr-452-mature && npx prettier --write src/channels/dispatcher.test.ts && \
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher.test.ts
```

Expected: exit 0, the whole file green including the pre-existing outage, deadline and per-turn blocks.

If an assertion about *which* deliver call is the audit copy proves brittle, keep the `auditCalls()` label filter (`source.label === "audit"`) as the discriminator; do not switch to positional indexing.

- [ ] **Step 4:** Commit.

```bash
git add src/channels/dispatcher.test.ts
git commit -m "test: pin audit routing destination, suppression and containment"
```

---

## Task 6: Fan-out site coverage (AC1, AC13 at the third call site)

**Files:**
- Modify: `src/channels/dispatcher-conference.test.ts` — widen the hoisted logger mock (`:15-23`), then append one describe block at the end of the file.

- [ ] **Step 1:** Widen the hoisted logger mock so `warn` is observable. Today the file hoists `mockLogInfo` only and hands `warn: vi.fn()` to `createLogger` (`:15-23`), so the Testing Contract's "one warn" minimum (main plan, Testing Contract → Integration → Minimum assertions) is currently met at the single-dispatch site alone. Only two lines change — the `vi.hoisted` destructuring/factory and the `warn:` field — but the whole of `:15-23` is reproduced below so the replacement is unambiguous. Leave the KPR-389 comment above it (`:10-14`) untouched:

```typescript
const { mockLogInfo, mockLogWarn } = vi.hoisted(() => ({ mockLogInfo: vi.fn(), mockLogWarn: vi.fn() }));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: mockLogInfo,
    warn: mockLogWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));
```

Nothing in this file asserts on `warn` today, and the suite's `vi.clearAllMocks()` in `beforeEach` resets the new mock exactly as it does `mockLogInfo` — so this is additive, not a behavior change to the existing blocks.

- [ ] **Step 2:** Append this block, using the file's existing `makeMockRegistry` / `makeMockAgentManager` / `makeMockAdapter` / `makeMockHealthReporter` / `makeWorkItem` helpers.

```typescript
// ---------------------------------------------------------------------------
// KPR-452: the fan-out / conference call site (dispatcher.ts:1885-1887) — the
// third of three. AC1 (destination) and AC13 (containment at the second
// AWAITED site, inside the try whose catch is handleTurnFailure at :1900).
// ---------------------------------------------------------------------------

describe("audit routing at the fan-out site (KPR-452)", () => {
  let dispatcher: Dispatcher;
  let registry: ReturnType<typeof makeMockRegistry>;
  let agentManager: ReturnType<typeof makeMockAgentManager>;
  let adapter: ReturnType<typeof makeMockAdapter>;
  let auditAdapter: ReturnType<typeof makeMockAdapter>;
  let listChannels: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    workItemCounter = 0;
    registry = makeMockRegistry();
    agentManager = makeMockAgentManager();
    adapter = { ...makeMockAdapter(), id: "ws", kind: "app" as any };
    auditAdapter = makeMockAdapter(); // kind: "slack"
    listChannels = vi.fn().mockResolvedValue({ channels: [] });
    dispatcher = new Dispatcher(
      registry as any,
      agentManager as any,
      makeMockHealthReporter() as any,
      "executive-assistant",
    );
    dispatcher.registerAdapter(adapter as any);
    dispatcher.setSlackAdapter({ client: { conversations: { list: listChannels } } } as any);
    dispatcher.setAuditChannel(auditAdapter as any, new Map([["ops-audit", "C-OPS"]]));
    dispatcher.setAuditChannelName("ops-audit");
  });

  const auditCalls = () =>
    auditAdapter.deliver.mock.calls.filter((c: any[]) => c[0]?.workItem?.source?.label === "audit");

  /** A ws/app item mentioning two agents by name → the fan-out leg. */
  function fanOutItem() {
    return makeWorkItem({
      source: { kind: "app", id: "dev1", label: "app:May", adapterId: "ws" },
      text: "Jasper, and River, coordinate",
      meta: { deviceId: "dev1" },
    });
  }

  it("AC1: each fanned-out agent's turn produces one audit copy in the audit channel", async () => {
    await dispatcher.dispatch(fanOutItem());
    expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    expect(auditCalls()).toHaveLength(2);
    for (const call of auditCalls()) {
      expect(call[0].workItem.source.id).toBe("C-OPS");
      expect(call[0].workItem.meta?.slackThreadTs).toBeUndefined();
      expect(call[0].workItem.meta?.slackTs).toBeUndefined();
    }
  });

  // ⚠ The channel name is set PER ROW, not once before both. Row 1 needs a
  // name absent from the map so the resolver is forced onto the refresh path;
  // row 2 needs a name that RESOLVES, or the turn returns at "No audit channel
  // resolved" and `deliver` is never reached — which would make the
  // deliver-rejection row assert nothing and leave AC13's mandated
  // deliver-rejection coverage at the fan-out site missing entirely.
  //
  // The third tuple element is the warn each row must actually reach — same
  // discriminating shape as the single-dispatch rows in Task 5, and what
  // carries the Testing Contract's "one warn" minimum to this site.
  it.each([
    [
      "conversations.list rejects",
      () => {
        listChannels.mockRejectedValue(new Error("slack 429"));
        return "not-in-map"; // miss ⇒ refresh ⇒ the rejecting call
      },
      "Audit channel refresh failed",
    ],
    [
      "auditAdapter.deliver rejects",
      () => {
        auditAdapter.deliver.mockRejectedValue(new Error("transport reset"));
        return "ops-audit"; // resolves from the map ⇒ reaches deliver
      },
      "Audit post failed",
    ],
  ])("AC13: the awaited fan-out site survives when %s", async (_label, arrange, expectedWarn) => {
    dispatcher.setAuditChannelName(arrange());
    const outageStore = { enqueue: vi.fn(), release: vi.fn(), markDone: vi.fn() };
    dispatcher.setOutageHandling({
      store: outageStore,
      config: { enabled: true, replayIntervalMs: 15_000, maxAgeHours: 4, maxDepth: 500, maxReplayAttempts: 3 },
      tracker: new OutageEpisodeTracker(),
    } as any);

    await dispatcher.dispatch(fanOutItem());

    // Both agents' own deliveries stand; handleTurnFailure was never entered.
    const texts = adapter.deliver.mock.calls.map((c: any[]) => String(c[0]?.text ?? ""));
    expect(texts).toHaveLength(2);
    expect(texts.some((t: string) => t.startsWith("Something went wrong"))).toBe(false);
    expect(outageStore.enqueue).not.toHaveBeenCalled();
    // The audit fault is contained AND observable: skip-and-warn, not silence.
    expect(mockLogWarn.mock.calls.some((c: any[]) => c[0] === expectedWarn)).toBe(true);
  });
});
```

Add only the imports the file does not already carry — `OutageEpisodeTracker` from `../outage/outage-notices.js`, and `makeMockHealthReporter` if it is not already in scope. Do not duplicate an existing import.

- [ ] **Step 3:** Verify.

```bash
cd /Users/mokie/github/hive-kpr-452-mature && npx prettier --write src/channels/dispatcher-conference.test.ts && \
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
```

Expected: exit 0, the whole file green — in particular the pre-existing KPR-416/417/420 tracker and ack blocks, which sit on the same code path.

**Confirm the primary path; do not default to the fallback.** The fixture is expected to reach the fan-out leg as written, and it should be made to: this file's `makeMockRegistry` carries `jasper` ("Jasper") and `river` ("River") and implements `findAllByName` with the `\b<name>[,:]` pattern, so `"Jasper, and River, coordinate"` matches both. `resolveAgents` reaches step 3 (name addressing) for this item — no `targetAgentId`, kind is `app` not `team`, no `meta.origin`, not a `conf-*` Slack channel, `findByChannel("app:May")` misses, and there is no `threadId` — and returns two agents. If `agentManager.runWorkItemTurn` is called twice, the primary path is confirmed and nothing below applies.

Only if that assertion genuinely fails: use the pattern already proven in `src/channels/dispatcher.test.ts` at `it("dispatcher: fan-out always uses runWorkItemTurn")` — a `slack`-kind item in the `random` channel mentioning two agents — and give the audit adapter `kind: "internal"` so D2 rule 2 does not exclude it. Record *why* the primary fixture failed in the child delivery handoff rather than switching silently. Do not weaken the assertion to a single agent.

- [ ] **Step 4:** Commit.

```bash
git add src/channels/dispatcher-conference.test.ts
git commit -m "test: cover the fan-out audit call site and its containment"
```
