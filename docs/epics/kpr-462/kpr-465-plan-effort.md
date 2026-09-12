# KPR-465 static-effort chunk (C) — deliver the KPR-430 `effort` field on voice turns

> **For agentic workers:** Use dodi-dev:implement only after chunks A, B and D Tasks D1–D3 are merged into the ticket branch and `npm run check` is green there (binding order, spec §9). This chunk is the first one that changes what a voice turn sends to the SDK.

**Goal:** An agent definition's static `effort` field (KPR-430) is delivered on voice turns — cold via the `prepareSpawn` carve-out, warm pinned for the call through `openVoiceStreamingSession` — with `effortSource: "static"` on `agent_turn_telemetry` for both lanes and the delivered value stamped on `engine_attempt_terminal`/`engine_terminal` from `TurnResult`; absence of the field leaves every voice turn byte-identical to today. No new `hive.yaml` key.

**Architecture:** Mechanism (a) of spec §4.1 — the carve-out calls the existing `resolveStaticClaudeEffort(agentConfig, staticTier, agentId)` (claude route only, so Lane A/B voice stays exactly as today and never sees a spurious off-catalog warn) and returns its value as `effortOverride` with `effortSource: "static"`. The warm opener resolves the same value once, pins it on `lease.opening.effort`, forwards it to `openVoiceStreamingSession` (new optional param → `buildQueryEnvelope`, which already delivers `effort`), and `runWarmTurn`'s inline shaping literal carries the pinned value so the KPR-430 telemetry stamp fires on warm turns. `TurnResult.effort` (voice only) is the single source the adapter stamps from — the adapter never re-derives it.

**Tech Stack:** TypeScript, existing `resolveStaticClaudeEffort`/`supportsEffort` gate, SDK `EffortLevel` pin, Vitest.

Spec authority: §4.1 (static effort), §3.2 (delivered `effort` stamp), §8 R3, R7, §9 ⚠ "agent-wide" note. KPR-430 ⚠ 1 ("one-line change if wanted") and KPR-430 §3 non-goals (no per-channel value, no `hive.yaml` knob) are honored: this chunk adds no config key. Canon R3: tool-ack, KPR-399/434 predicates unchanged.

## Testing Contract (chunk C)

### Required Test Groups

- Unit: `required`
  - Scope: `src/agents/agent-manager.test.ts` — the voice carve-out and the warm opener; `src/voice/voice-diagnostic-reader.test.ts` — `effort` allowlist/validation.
  - Reason: delivery is a pure function of (field, model tier, catalog capability, route provider, channel).
  - Minimum assertions (R3 matrix): field absent → cold voice `mockRunnerSend.mock.calls[0][6] === undefined`, warm `mockRunnerOpenStream.mock.calls[0][0].effort === undefined`, telemetry has no `effort`/`effortSource` (today); field invalid on the doc (registry sanitises at load — assert via a doc with `effort: "turbo"` that the registry's load-time sanitiser drops it, existing KPR-430 test) → same as absent; field valid → cold voice delivers it (`calls[0][6] === "medium"`), telemetry `{ effort: "medium", effortSource: "static" }`, `TurnResult.effort === "medium"`; warm → `openStream` params carry `effort: "medium"`, turn 1 and turn 2 telemetry both `{ effort: "medium", effortSource: "static" }`, `r1.effort === r2.effort === "medium"`; haiku voice → undefined + exactly one static warn across two turns; off-catalog (`mockSupportsEffort` false) voice → undefined + one warn; Lane A voice (`kimi/kimi-k3` + field) → undefined and **zero** static warns (route gate); non-voice, reflection, Lane B → the existing KPR-430 T1–T5 pins unchanged; reader accepts `effort: null` and each of the five levels, rejects `"turbo"` and a number.
- Integration: `required`
  - Scope: `src/channels/voice/voice-adapter.integration.test.ts` (attempt/request terminal `effort` from `TurnResult`, and `null` when absent); `src/channels/voice/voice-startup.integration.test.ts` (real manager: a `mokie` definition with `effort: "medium"` → `runnerControl.openStream` called with `effort: "medium"` and the attempt terminal row carries `effort: "medium"`).
  - Reason: the stamp rides `TurnResult` across the seam; the warm pin rides the real opener.
  - Harness: `existing`.
  - Minimum assertions: as listed.
- E2E: `not-required` in this chunk (the A2 arms run in chunk E under the live protocol).

### Critical Flows

- Cold voice with field → carve-out → `effortOverride` → `adapter.runTurn({ effort })` → `send(..., effort)` → envelope `effort`.
- Warm voice with field → opener resolves once → `openVoiceStreamingSession({ effort })` → envelope; every turn's telemetry stamped from the pinned value.
- Field absent → `resolveStaticClaudeEffort` returns `undefined` without a registry call (non-adopters byte-identical, KPR-430 T5c).

### Regression Surface

- Every non-voice `prepareSpawn` branch (round-1 pin, Lane A clamp, Lane B, system-sender, router-on/off) — untouched lines; existing pins prove it.
- Reflection turns on voice threads: the manager builds a reflection ctx with the originating turn's `channel`, so a voice-thread reflection reaches the carve-out today (raw prompt, no router) and after this change also receives the static field — exactly what KPR-430 already does for reflection on every other channel ("a `max` agent reflects at `max`"). Pinned by T4d below; it is not a regression, it is the field becoming channel-uniform.
- Warm eligibility, lease lifetimes, `selectText`, cancellation — untouched.

### Commands

- Unit: `npx vitest run src/agents/agent-manager.test.ts -t "KPR-430|KPR-465|voice" && npx vitest run src/voice/voice-diagnostic-reader.test.ts`
- Integration: `npx vitest run src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts`
- Broader: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`

### Harness Requirements

- `agent-manager.test.ts` already mocks `getLLMRegistry().supportsEffort` (`mockSupportsEffort`) and captures `staticWarns()`; the warm block's `installEchoStreamingRunner` captures `mockRunnerOpenStream.mock.calls[0][0]`.
- The startup suite's `makeFixture()` builds the `mokie` definition; add an `effort` override parameter to it.

### Non-Required Rationale

- E2E: live A2 arms are chunk E's; no offline E2E is unique here.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- The KPR-430 T4 voice pin (`agent-manager.test.ts` ~6559, "voice path delivers nothing even with the field set") is the ONE test this chunk is expected to flip; re-pin it in Task C2's commit with the negative-verify recorded (revert C1 → the re-pinned test fails).

---

### Task C1: Carve-out, lease pin, runner param, `TurnResult.effort`

**Files:**
- Modify: `src/agents/agent-manager.ts:196-250` (`TurnResult`), `:369-376` (`WarmVoiceLease`), `:1700-1716` (cold voice block), `:1925-1945` (opener pin), `:1979-1990` (open call), `:2106-2135` (`runWarmTurn` result + shaping literal), `:2826-2829` (carve-out)
- Modify: `src/agents/agent-runner.ts:2790-2806` (`openVoiceStreamingSession`)

- [ ] **Step 1: `TurnResult.effort`.**

After `warmTurnSeq?: number;` add:

```typescript
  /**
   * KPR-465 §3.2/§4.1: the static effort actually delivered to the SDK on a
   * VOICE turn (cold: prepareSpawn's carve-out; warm: the lease's pinned
   * opening value). undefined on every other channel and whenever nothing was
   * delivered. The voice adapter stamps engine_attempt_terminal.effort from
   * this field and never re-derives it.
   */
  effort?: AgentEffort;
```

(`AgentEffort` is already imported in this file for `resolveStaticClaudeEffort`.)

- [ ] **Step 2: Carve-out.**

Replace lines 2826–2829:

```typescript
    // Voice carve-out: KPR-219 supplies its own systemPromptOverride and
    // explicitly bypasses prepending + model router. Pin via this branch so
    // future prepareSpawn edits cannot accidentally re-shape voice prompts.
    // KPR-465 §4.1 (KPR-430 ⚠ 1's sanctioned one-line change): the static
    // agent-definition `effort` field IS delivered on voice — claude route
    // only, so Lane A/B voice stays byte-identical and never sees the
    // off-catalog warn. No per-channel value, no hive.yaml key (KPR-430 §3).
    if (ctx.channel === "voice") {
      const staticEffort =
        staticRoute.provider === "claude" ? this.resolveStaticClaudeEffort(agentConfig, staticTier, ctx.agentId) : undefined;
      return {
        prompt: item.text,
        route: staticRoute,
        resourceLimits: undefined,
        routerCostUsd: 0,
        effortOverride: staticEffort,
        ...(staticEffort ? { effortSource: "static" as const } : {}),
        ...(voiceAdmission ? { voiceAdmission } : {}),
      };
    }
```

- [ ] **Step 3: Cold `TurnResult.effort`.**

In the cold voice block (line ~1706, inside `if (effectiveCtx.channel === "voice") {`) add after the `stageTimings` assignment:

```typescript
        if (isAgentEffort(shaping.effortOverride)) turnResult.effort = shaping.effortOverride;
```

(`isAgentEffort` is imported from `./agent-effort.js` in this file; confirm at the import block.)

- [ ] **Step 4: Lease pin.**

Extend `WarmVoiceLease.opening` with `readonly effort?: AgentEffort;`. In `openWarmLeaseAttempt` where `pinnedLease` is built (line ~1929):

```typescript
      definition = this.registry.get(ctx.agentId)!;
      const openingRoute = resolveProviderModel(definition.model);
      // KPR-465 §4.1: resolve the static field ONCE and pin it for the call
      // like the model and prompt (definition reloads apply to the next lease).
      // Claude by construction here (isWarmPathEligible), so no route gate.
      const openingEffort = this.resolveStaticClaudeEffort(definition, modelToTier(definition.model), ctx.agentId);
      // ... existing sessionProvider reconciliation and shapeVoicePrompt ...
      pinnedLease = Object.assign(lease, {
        opening: {
          model: definition.model,
          route: openingRoute,
          timeoutMs: definition.timeoutMs ?? 300_000,
          resumeSessionId: openingCtx.sessionId,
          ...(openingEffort ? { effort: openingEffort } : {}),
        },
      });
```

In the open call (line ~1979) add `effort: pinnedLease.opening.effort,` to the `openVoiceStreamingSession({...})` params.

- [ ] **Step 5: `runWarmTurn` shaping literal and result.**

Replace the inline shaping literal (lines ~2125–2131):

```typescript
    // The warm lane's shaping is exactly what prepareSpawn's voice carve-out
    // returns (raw text + the static route, no router, no resource limits,
    // KPR-465: the pinned static effort) — constructed inline because
    // prepareSpawn is not re-entered on a warm turn. Same `route` object the
    // breaker permit was keyed on. The effort here MUST be the lease's pinned
    // value or warm A2 turns get no effort/effortSource in agent_turn_telemetry.
    const pinnedEffort = lease.opening.effort;
    this.recordSpawnObservability(ctx, {
      prompt: ctx.workItem.text,
      route,
      resourceLimits: undefined,
      routerCostUsd: 0,
      effortOverride: pinnedEffort,
      ...(pinnedEffort ? { effortSource: "static" as const } : {}),
    }, runResult, resumedSession, model);
```

and after `turnResult.warmTurnSeq = warmTurnSeq;` add `if (pinnedEffort) turnResult.effort = pinnedEffort;` (declare `pinnedEffort` above that line so both sites share it).

- [ ] **Step 6: Runner param.**

```typescript
  async openVoiceStreamingSession(params: {
    input: AsyncIterable<SDKUserMessage>;
    sessionId: string | undefined;
    context: WorkItemContext;
    systemPromptOverride: string;
    /** KPR-465 §4.1: the lease's pinned static effort; delivered by buildQueryEnvelope exactly as on send(). */
    effort?: AgentEffort;
  }): Promise<Query> {
    log.info("Opening warm voice streaming session", {
      agent: this.agentConfig.id,
      resumeSession: params.sessionId ?? "new",
      ...(params.effort ? { effort: params.effort } : {}),
    });

    const options = await this.buildQueryEnvelope({
      sessionId: params.sessionId,
      context: params.context,
      systemPromptOverride: params.systemPromptOverride,
      effort: params.effort,
      streaming: true,
    });
```

- [ ] **Step 7: Typecheck and commit.**

Run: `npx tsc --noEmit` — exit 0.

```bash
git add src/agents/agent-manager.ts src/agents/agent-runner.ts
git commit -m "feat(voice): deliver the static agent effort field on cold and warm voice turns (KPR-465, KPR-430 ⚠1)"
```

### Task C2: Manager tests — re-pin T4, add the R3 matrix

**Files:**
- Modify: `src/agents/agent-manager.test.ts` (~5705, ~6559, warm block)

- [ ] **Step 1: Re-pin the two voice pins.**

At ~5705 keep the test but retitle: `"voice path with no static field delivers no effort (carve-out — router never runs)"` — assertions unchanged (`routeModel` not called, `calls[0][4]` and `calls[0][6]` undefined).

At ~6559 replace:

```typescript
    it("T4 (KPR-465): voice path delivers the static field (carve-out still skips the router)", async () => {
      (appConfig as any).modelRouter.enabled = true;
      const id = setFable("medium");
      const item = makeWorkItem({ text: "voice turn", source: { kind: "ws", id: "voice-1", label: "voice" } });
      const result = await manager.spawnTurn({ ...makeSmsCtx({ agentId: id, threadId: "voice:1", workItem: item }), channel: "voice" as const });
      expect(routeModel).not.toHaveBeenCalled();
      expect(mockRunnerSend.mock.calls[0]![4]).toBeUndefined(); // resourceLimits still pinned undefined
      expect(mockRunnerSend.mock.calls[0]![6]).toBe("medium");
      expect(result.effort).toBe("medium");
      expect(turnTelemetryStore.record.mock.calls[0]![0]).toMatchObject({ effort: "medium", effortSource: "static" });
      expect(staticWarns()).toHaveLength(0);
    });

    it("T4b (KPR-465): voice haiku agent with the field — nothing delivered, one warn, no TurnResult.effort", async () => {
      registry._agents.set("agent-hv", makeAgentConfig({ id: "agent-hv", name: "Hv", model: "claude-haiku-4-5", effort: "max" }));
      const item = makeWorkItem({ text: "v", source: { kind: "ws", id: "voice-1", label: "voice" } });
      const r1 = await manager.spawnTurn({ ...makeSmsCtx({ agentId: "agent-hv", threadId: "voice:h1", workItem: item }), channel: "voice" as const });
      await manager.spawnTurn({ ...makeSmsCtx({ agentId: "agent-hv", threadId: "voice:h2", workItem: item }), channel: "voice" as const });
      expect(mockRunnerSend.mock.calls[0]![6]).toBeUndefined();
      expect(r1.effort).toBeUndefined();
      expect(staticWarns()).toHaveLength(1);
      expect(turnTelemetryStore.record.mock.calls[0]![0]).not.toHaveProperty("effortSource");
    });

    it("T4c (KPR-465): Lane A voice agent with the field — unchanged: nothing delivered and ZERO static warns (route gate)", async () => {
      registry._agents.set("agent-kv", makeAgentConfig({ id: "agent-kv", name: "Kv", model: "kimi/kimi-k3", effort: "high" }));
      const item = makeWorkItem({ text: "v", source: { kind: "ws", id: "voice-1", label: "voice" } });
      await manager.spawnTurn({ ...makeSmsCtx({ agentId: "agent-kv", threadId: "voice:k1", workItem: item }), channel: "voice" as const });
      expect(mockRunnerSend.mock.calls[0]![6]).toBeUndefined();
      expect(staticWarns()).toHaveLength(0);
    });

    it("T4d (KPR-465): reflection turn on a voice thread delivers the field like any other reflection", async () => {
      const id = setFable("low");
      const item = makeWorkItem({ text: "reflect", source: { kind: "ws", id: "voice-1", label: "voice" } });
      await manager.spawnTurn({ ...makeSmsCtx({ agentId: id, threadId: "voice:r1", workItem: item }), channel: "voice" as const, kind: "reflection" as const });
      expect(mockRunnerSend.mock.calls[0]![6]).toBe("low");
    });
```

(If the Lane A voice ctx needs a Honeypot-resolved key to reach `send`, the existing Lane A tests show how `resolveSecretEnv` is mocked — mirror it; the assertion of interest is `staticWarns()` being empty, which holds even if the turn fails on credential assembly.)

- [ ] **Step 2: Warm block.**

```typescript
    it("KPR-465: a static effort field is pinned on the lease, forwarded to openVoiceStreamingSession, and stamped on every warm turn", async () => {
      registry._agents.set("agent-a", makeAgentConfig({ ...registry._agents.get("agent-a")!, effort: "medium" }));
      installEchoStreamingRunner();
      const r1 = await manager.spawnTurn(makeVoiceCtx({ sessionId: undefined }));
      const r2 = await manager.spawnTurn(makeVoiceCtx({ sessionId: "sess-warm-1" }));
      expect(mockRunnerOpenStream).toHaveBeenCalledTimes(1);
      expect(mockRunnerOpenStream.mock.calls[0]![0].effort).toBe("medium");
      expect(r1.effort).toBe("medium");
      expect(r2.effort).toBe("medium");
      expect(turnTelemetryStore.record.mock.calls[0]![0]).toMatchObject({ effort: "medium", effortSource: "static" });
      expect(turnTelemetryStore.record.mock.calls[1]![0]).toMatchObject({ effort: "medium", effortSource: "static" });
      expect(mockRunnerSend).not.toHaveBeenCalled();
    });

    it("KPR-465: no field ⇒ the lease opens without effort and telemetry carries no effortSource (today)", async () => {
      installEchoStreamingRunner();
      const r1 = await manager.spawnTurn(makeVoiceCtx({ sessionId: undefined }));
      expect(mockRunnerOpenStream.mock.calls[0]![0]).not.toHaveProperty("effort");
      expect(r1.effort).toBeUndefined();
      expect(turnTelemetryStore.record.mock.calls[0]![0]).not.toHaveProperty("effort");
    });

    it("KPR-465: a definition reload mid-call does not change the pinned effort until the next lease", async () => {
      registry._agents.set("agent-a", makeAgentConfig({ ...registry._agents.get("agent-a")!, effort: "medium" }));
      installEchoStreamingRunner();
      const r1 = await manager.spawnTurn(makeVoiceCtx({ sessionId: undefined }));
      registry._agents.set("agent-a", makeAgentConfig({ ...registry._agents.get("agent-a")!, effort: "low" }));
      const r2 = await manager.spawnTurn(makeVoiceCtx({ sessionId: "sess-warm-1" }));
      expect(r1.effort).toBe("medium");
      expect(r2.effort).toBe("medium");
    });
```

- [ ] **Step 3: Verify (with negative-verify).**

Run: `npx vitest run src/agents/agent-manager.test.ts` — pass. Revert Task C1 Step 2 (carve-out) only → T4 and T4b fail; revert Step 5 only → the warm telemetry assertions fail; restore both.

- [ ] **Step 4: Commit.**

```bash
git add src/agents/agent-manager.test.ts
git commit -m "test(voice): re-pin KPR-430 T4 to static effort on voice; R3 matrix (KPR-465)"
```

### Task C3: Stamp `effort` on the engine payload

**Files:**
- Modify: `src/voice/voice-trace.ts` (`EnginePayload`), `src/channels/voice/voice-adapter.ts` (attempt/request terminals)
- Test: `src/channels/voice/voice-adapter.integration.test.ts`, `src/channels/voice/voice-startup.integration.test.ts`

- [ ] **Step 1: Payload key.**

```typescript
  /** KPR-465 §3.2: static effort the envelope actually carried (voice); null when nothing was delivered. */
  effort?: AgentEffort | null;
```

with `import type { AgentEffort } from "../agents/agent-effort.js";` at the top of `voice-trace.ts` (type-only; the module stays worker-importable and dependency-free at runtime).

- [ ] **Step 2: Adapter stamps (read from `TurnResult`, never re-derived).**

Attempt terminal: `effort: attemptResult?.effort ?? null,`. Request terminal: `effort: finalResult?.effort ?? null,`.

- [ ] **Step 3: Tests.**

`voice-adapter.integration.test.ts` (real helpers: `makeAdapter`, `workerShapedBody`, `postChatCompletion`, `echoTurnResult`, `engineRows`):

```typescript
  it("KPR-465: attempt and request terminals carry the delivered effort from TurnResult, null when absent", async () => {
    const withEffort = async (_ctx: TurnContext, onStream?: (c: string) => void): Promise<TurnResult> => {
      onStream?.("hi");
      return { ...echoTurnResult("hi"), effort: "medium" };
    };
    const a = await makeAdapter({ spawn: withEffort });
    try {
      await postChatCompletion(a.port, workerShapedBody("effort-465"), { bearer: BRIDGE_TOKEN });
      expect(engineRows("engine_attempt_terminal").find((r) => r.callId === "effort-465")!.effort).toBe("medium");
      expect(engineRows("engine_terminal").find((r) => r.callId === "effort-465")!.effort).toBe("medium");
    } finally {
      a.adapter.stop();
    }
    const b = await makeAdapter({ spawn: echoSpawn() });
    try {
      await postChatCompletion(b.port, workerShapedBody("noeffort-465"), { bearer: BRIDGE_TOKEN });
      expect(engineRows("engine_attempt_terminal").find((r) => r.callId === "noeffort-465")!.effort).toBeNull();
    } finally {
      b.adapter.stop();
    }
  });
```

`voice-startup.integration.test.ts` — in the warm case family, one more `it`: `makeFixture({ effort: "medium" })` (extend the fixture factory to set `effort` on the `mokie` definition), two warm turns, then `expect(runnerControl.openStream.mock.calls[0]![0]).toMatchObject({ effort: "medium" })` and `expect(rows(callId, "engine_attempt_terminal")[1]).toMatchObject({ warm: true, effort: "medium" })`.

- [ ] **Step 4: Commit.**

```bash
git add src/voice/voice-trace.ts src/channels/voice/voice-adapter.ts src/channels/voice/voice-adapter.integration.test.ts src/channels/voice/voice-startup.integration.test.ts
git commit -m "feat(voice): stamp delivered effort on engine terminals from TurnResult (KPR-465)"
```

### Task C4: Reader allowlist + fixture regeneration

**Files:**
- Modify: `src/voice/voice-diagnostic-reader.ts` (`PAYLOAD_FIELDS`, `validatePayload`), `src/voice/testing/compare-fixture.ts` (defaults), fixtures
- Test: `src/voice/voice-diagnostic-reader.test.ts`

- [ ] **Step 1: Allowlist + validation.**

Add `"effort"` to `PAYLOAD_FIELDS.engine_attempt_terminal` and `.engine_terminal`. In `validatePayload` add:

```typescript
  if (
    "effort" in value &&
    value.effort !== undefined &&
    value.effort !== null &&
    !["low", "medium", "high", "xhigh", "max"].includes(String(value.effort))
  ) {
    return false;
  }
```

(Literal list, not an import from `agent-effort.ts`: the reader is a pure offline module and must not pick up engine imports; add a one-line test that the literal equals `AGENT_EFFORT_LEVELS` so drift fails loudly.)

- [ ] **Step 2: Tests.**

```typescript
  it("KPR-465: effort on engine terminals accepts null and the five levels, rejects anything else", () => {
    for (const e of [null, "low", "medium", "high", "xhigh", "max"]) expect(parseVoiceDiagnosticEvent({ ...base, effort: e })).not.toBeNull();
    expect(parseVoiceDiagnosticEvent({ ...base, effort: "turbo" })).toBeNull();
    expect(parseVoiceDiagnosticEvent({ ...base, effort: 3 })).toBeNull();
  });
  it("KPR-465: reader effort literal tracks AGENT_EFFORT_LEVELS", () => {
    expect([...AGENT_EFFORT_LEVELS]).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });
```

- [ ] **Step 3: Flip the fixture defaults and regenerate.**

In `compare-fixture.ts` set `effort: null` in `cold(...)` defaults and `effort: "medium"` in `warm(...)` defaults (the `call-old` call keeps `effort: "omit"`). Then:

```bash
KPR465_WRITE_FIXTURES=1 npx vitest run src/voice/voice-latency-compare.test.ts
npx vitest run src/voice/voice-latency-compare.test.ts scripts/voice-latency-compare.test.ts src/voice/voice-diagnostic-reader.test.ts
```

Expected: pass; `git diff --stat` shows only `kpr-465-compare.jsonl` changed (the `effort` key added on engine terminals). Add to the compare test: `expect(warm.turns.every((t) => t.effort === "medium")).toBe(true); expect(cold.turns.every((t) => t.effort === null)).toBe(true);`.

- [ ] **Step 4: Commit.**

```bash
git add src/voice/voice-diagnostic-reader.ts src/voice/voice-diagnostic-reader.test.ts src/voice/testing/compare-fixture.ts src/voice/voice-latency-compare.test.ts docs/epics/kpr-462/fixtures/kpr-465-compare.jsonl
git commit -m "feat(voice): allowlist effort on engine terminals; fixtures carry delivered effort (KPR-465)"
```

### Task C5: Remove the chunk-B cast

- [ ] In `src/voice/voice-latency-compare.ts` `buildTurnRows`, replace the `(final as { effort?: unknown })` cast with `final.effort ?? null` now that `EnginePayload.effort` exists. Run `npx tsc --noEmit` and the compare tests; commit `refactor(voice): read attempt effort through the payload type (KPR-465)`.

### Task C6: `docs/providers.md`

**Files:**
- Modify: `docs/providers.md:79` (voice bullet), History section (append)

- [ ] **Step 1: Amend the voice bullet** — append one sentence to the "Voice is not provider-pinned" bullet:

> Since KPR-465 the KPR-430 static `effort` field is delivered on voice turns too (cold via the `prepareSpawn` carve-out, warm pinned for the whole call at lease open) — Claude route only; Lane A/B voice remains unchanged. The field is agent-wide: a definition carrying `xhigh`/`max` now delivers it on that agent's voice turns as well, which KPR-430's own rationale calls a latency footgun — check every voice-capable definition before deploying, and prefer `medium`/`low` on agents that take calls.

- [ ] **Step 2: History entry.**

> 2026-09-12 — KPR-465: the static per-agent `effort` field (KPR-430) now reaches voice turns (both the cold per-turn spawn and the warm lease, which pins the value for the call). No matrix row changes — row 12 already describes the field; this only removes voice from its list of exclusions. No config key was added; the field's absence leaves voice byte-identical to before. Telemetry: `agent_turn_telemetry.effortSource: "static"` on voice rows; `voice_diagnostic` engine terminals carry the delivered `effort` (or `null`). History entry only.

- [ ] **Step 3: Commit.**

```bash
git add docs/providers.md
git commit -m "docs(providers): voice turns now receive the static effort field (KPR-465)"
```

### Task C7: Chunk gate

- [ ] `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — exit 0.
- [ ] Record in the delivery notes: the T4 flip with its negative-verify, and the statement that the chunk adds no `hive.yaml` key (grep `config.ts` diff is empty for this chunk).
