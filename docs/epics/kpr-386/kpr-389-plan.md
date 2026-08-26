# KPR-389 — Implementation Plan: Meeting turn-kind awareness (conferenceRound into spawn shaping + preamble hardening)

**Goal:** Round-1 conference reaction turns spawn cheap (no effort classifier, effort pinned `low` on claude-runtime lanes, `maxTurns`/`timeoutMs` clamped to `min(base, 6 / 120s)` on all three lanes); the meeting preamble stops inviting tool re-orientation; killed reactions never post filler into the meeting (fan-out AND replay legs); `conferenceRound` + `injectionMode` + `resumedSession` + the perf split land in `agent_turn_telemetry` / `activity_log` for before/after measurement. Round-0 primaries and all non-conference turns byte-identical on every path.

**Tech stack:** TypeScript strict, vitest (tests beside source), Node 22/24 dev.
**Spec:** `docs/epics/kpr-386/kpr-389-spec.md` (spec-ready, clean r3 — binding: D1–D6, E1–E10, T1–T10+T8b).
**Canon:** C1–C13 bind. This is the **only ticket licensed to edit the C6/C10 preamble pins** — both updates are deliberate, spec-level decisions (D4), executed in Task 3. C3's round-1 terminal slot stays byte-intact; C4's escape phrase `"No response needed."` is preserved verbatim; C12 mark-bookkeeping placement untouched; C13's anchor site (`buildConferenceContext` full arm) untouched.

**Base:** branch `KPR-386` @ `5029b07` (KPR-387 `3896a24`, KPR-388 `7f6d92f` merged).

---

## Verified code surfaces (pre-plan verification, this worktree)

| Spec claim | Verified at |
|---|---|
| Meta stamp `conferenceMode/conferenceHumanTs/conferenceRound` | `src/channels/dispatcher.ts:1029–1035` (`dispatchToAgent`) |
| `ResolvedAgent.injectionMode` exists | dispatcher.ts:57–70 |
| Round-0 stamp / round-1 stamp | dispatcher.ts:1250 / :1460 |
| Single-dispatch body (D5b site) | dispatcher.ts:299–381 (`isNonResponse` :324–326, filler :336, `recordTurnSuccess` :373–375) |
| Fan-out suppression log | dispatcher.ts:1089 (`Non-response suppressed (fan-out)`, `{ agentId }` only) |
| Single-dispatch suppression log | dispatcher.ts:327 |
| `buildMeetingPreamble` | dispatcher.ts:1350–1360 |
| Replay pinned path (bare ResolvedAgent, single-dispatch) | dispatcher.ts:214–229, :816–818 |
| Replay meta spread preserves `conferenceRound`; `replayWrap` wraps text | `src/outage/outage-replay-processor.ts:102–107` |
| `prepareSpawn` structure: voice carve-out :1665, prompt assembly ends :1709, Lane A :1717, Lane B :1744, router gate :1763, static limits :1771, haiku/effort skip :1780, `routeModel` :1792 | `src/agents/agent-manager.ts` |
| KPR-354 turn-scoped literal template | agent-manager.ts:724 |
| `runOneSpawnAttempt` delivers `shaping.resourceLimits` / `shaping.effortOverride` to `adapter.runTurn` | agent-manager.ts:1554–1562 |
| `finalAttemptSessionId` (C7 source) / `recordSpawnObservability` call site | agent-manager.ts:1023 / :1123 |
| `recordSpawnObservability` telemetry gate `result.sessionId && !result.aborted`; activity record site | agent-manager.ts:1828 / :1867 |
| KPR-313 guard fires only on `sessionProvider && sessionProvider !== route.provider` (undefined ⇒ no strip) | agent-manager.ts:971 |
| Runner delivery: `maxTurns` Options :1954, effort narrowing {low,medium,high} :1964, deadline `resourceLimits?.timeoutMs ?? agentConfig.timeoutMs ?? 300_000` :2026 | `src/agents/agent-runner.ts` |
| Tier defaults haiku 120s/20/1, sonnet 300s/50/5, opus 600s/200/50; `ModelTier` exported | `src/agents/model-router.ts:8–40` |
| `TurnTelemetryDoc/Input` token-only today; 14d TTL | `src/agents/turn-telemetry.ts:6–31,60` |
| `ActivityRecord` has no conferenceRound | `src/activity/types.ts` |
| C6 pin :501–510, C10 `PREAMBLE` helper :516–523 (feeds :585–587, :941); reviewer-pin section :947+ reuses helpers | `src/channels/dispatcher-conference.test.ts` |
| `NON_RESPONSE_PATTERNS` (3 entries, module-private) | dispatcher.ts:40–44 |
| agent-manager test harness: `mockRunnerSend(prompt, sessionId, onStream, ctx, resourceLimits, sysOverride, effort)` — limits idx 4, effort idx 6; `mockCodexRunTurn` request object; `registry._agents`; `(appConfig as any).modelRouter.enabled`; grok describe seeds `GROK_GATEWAY_KEY` | `src/agents/agent-manager.test.ts:196–400, 682–760, 3514–3560` |
| No import cycle: agent-manager imports nothing from `channels/` | agent-manager.ts imports |

---

## Testing Contract

### Unit (vitest, beside source — the spec's T1–T10+T8b are the minimum set)

| ID | Suite | Scope | Minimum assertions |
|---|---|---|---|
| T1/T1b/E7 | `agent-manager.test.ts` | Round-1 claude shaping, router on AND off, tight-operator-config, haiku | `routeModel` **zero calls**; runner limits `{6, 120_000, tier-or-legacy budget}`; router-off base = agent-def legacy triple (operator `maxTurns: 3` survives the min()); effort `"low"` (haiku: `undefined`) |
| T2/T2b | `agent-manager.test.ts` | Round-0 + non-conference negative pins (D3) | `routeModel` called once; limits deep-equal `RESOURCE_TIER_DEFAULTS.sonnet`; effort = classifier output |
| T3 | `agent-manager.test.ts` | Lane B (codex) round 1 + round 0 | round 1: `req.resourceLimits = {6, 120_000, 10}`, `req.effort` undefined; round 0: `{25, 300_000, 10}` byte-identical to today's Lane B branch |
| T4 | `agent-manager.test.ts` (inside the existing KPR-371 grok describe) | Lane A grok `:high` round 1 + round 0 | round 1: effort `"low"` overrides suffix, limits `{6, 120_000, 10}` materialized; round 0: effort `"high"`, limits `undefined` |
| T5 | `dispatcher-conference.test.ts` | **Deliberate** C6 + C10 pin updates (this ticket's license) | Both pins byte-pin the NEW literal; delta pin :585 and empty-delta pin :941 stay green transitively (full join shape still pinned) |
| T6 | `dispatcher-conference.test.ts` | C4 structural guard | Every double-quoted phrase extracted from real `buildMeetingPreamble` output; ≥1 matches a local mirror of `NON_RESPONSE_PATTERNS` |
| T7/T7b/T7c | `agent-manager.test.ts` | D6 telemetry | round-1 turn: `record()` receives `conferenceRound: 1, injectionMode, resumedSession: true, durationMs/llmMs/toolMs/toolCalls, effort: "low"`; activity record carries `conferenceRound: 1`; DM turn: perf fields present, conference keys **absent**; aborted reaction: telemetry skipped, activity still round-tagged |
| T8 | `dispatcher-conference.test.ts` | D5 fan-out kill suppression (aborted + timedOut variants) + errored-with-text delivers + round-0 control | killed round-1 ⇒ zero `deliver` for the reactor, mark untouched; killed round-0 still delivers `"_No response._"` (today's behavior) |
<!-- reviewer note (plan-review r1): the kill tests' deliver-count assert runs synchronously after waitFor(runWorkItemTurn × 2); with the all-mock harness this is safe, but waiting additionally on a post-turn signal (e.g. jasper's setMeetingMark call, as the existing :991 pin does) makes the negative airtight — implementer may add it. -->
| T8b | `dispatcher.test.ts` (outage describe) | D5b replay leg | killed replayed reaction ⇒ no `deliver`, `store.release(id, agent, "done")` **still called** (`recordTurnSuccess` intact); text-bearing kill delivers; real-text control delivers |
| T9 | `dispatcher.test.ts` | Replay shaping continuity | item reaching `runWorkItemTurn` retains `meta.conferenceRound === 1` through the pinned path; fan-out guard did not fire (delivery still happens for a good replay) |
| T10 | `agent-manager.test.ts` | `conferenceRoundOf` table | `0→0`, `1→1`, `"1"→undefined`, `2→undefined`, `undefined→undefined`, missing meta→undefined |

### Integration
None new. The conference suites ARE the integration harness (dispatcher + mocked manager end-to-end through `dispatch()`); spawn shaping runs through real `spawnTurn`/`prepareSpawn` against mocked adapters. No live-Slack or live-provider tests (see Non-Required Rationale).

### E2E
None in-repo. Live validation is what D6's telemetry exists for: post-deploy, one TTL window of `conferenceRound`-segmented data in `agent_turn_telemetry`/`activity_log` on the fleet (`#conf-tahoe`).

## Critical Flows

1. **Live reaction:** human msg → round-0 fan-out → responder replies → `triggerConferenceReactions` → round-1 `ResolvedAgent` (`conferenceRound: 1`) → `dispatchToAgent` stamps meta → `runWorkItemTurn` sets `ctx.conferenceRound` → `prepareSpawn` round-1 branch → capped/pinned spawn → decline suppressed (round-tagged log) or reply delivered; a kill is silent (D5).
2. **Round-0 primary / plain DM:** meta 0 or absent ⇒ branch not taken ⇒ byte-identical shaping (T2/T2b negative pins).
3. **Replayed reaction (C12):** outage → queued shaped item → replay pins `targetAgentId` → single-dispatch path → meta survives ⇒ reaction caps re-apply; killed-again ⇒ delivery-only suppression, doc still resolves `done` (D5b).
4. **Measurement:** every finalized turn → activity log (`conferenceRound`, kills included); every non-aborted session turn → turn telemetry (round, injection mode, resumedSession, perf split, effort).

## Regression Surface

- `src/channels/dispatcher-conference.test.ts` — 28 runtime tests (24 `it` + 4 `it.each` cases). All stay green; the **only** intentional diffs are the two preamble literals (C6 `expectedPreamble`, C10 `PREAMBLE` helper). The round-0 byte pin retains full-join byte-identity rigor with the NEW literal — same shape, `${preamble}\n---\n[New message]:\n${text}`.
- `src/agents/agent-manager.test.ts` — full suite (207 `it` blocks, ~229 at runtime with parameterization). **Whole-file runs only — never `-t`** (module-mock ordering).
- `src/channels/dispatcher.test.ts` — full file (non-response patterns local copy untouched).
- Full `npm run check` (typecheck + lint + format + test) and `npm run check:bundle` (bundle + 4 guards).
- Known pre-existing quirk: one KPR-387-era conference test is shuffle-order-dependent. If an unrelated conference test flakes, re-run the whole file; do **not** fix it in this ticket.

## Commands

All test/check commands need the env stubs (config load trips on `SLACK_BOT_TOKEN`):

```bash
cd /Users/mokie/github/hive-KPR-386
export SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test

npx vitest run src/agents/agent-manager.test.ts          # whole file only
npx vitest run src/channels/dispatcher-conference.test.ts
npx vitest run src/channels/dispatcher.test.ts
npm run typecheck
npm run check                                            # full sweep
npm run check:bundle                                     # bundle + guards (final task)
```

Expected: `Test Files N passed`, zero failures; `npm run check` exits 0.

## Harness Requirements

- **Async drain:** reaction-pass assertions poll with `vi.waitFor(() => …)` (`triggerConferenceReactions` is fire-and-forget behind the round-0 delivery). Never assert "not called" inside `waitFor` — first `waitFor` a positive completion signal (e.g. `runWorkItemTurn` called twice), then assert the negative synchronously.
- **Router on/off:** flip `(appConfig as any).modelRouter.enabled` inside `try { … } finally { … = false }` (existing convention, agent-manager.test.ts:673–680, 3778–3796). Router-off is the harness default.
- **Tier limits:** import `RESOURCE_TIER_DEFAULTS` (already imported in agent-manager.test.ts:196); assert clamps against those values plus `makeAgentConfig` legacy defaults (`maxTurns: 25`, `budgetUsd: 10`, no `timeoutMs` ⇒ 300 000 fallback).
- **Lane fixtures:** claude effort-capable = `agent-s` (sonnet; `mockSupportsEffort` = `!model.includes("haiku")`); haiku = `agent-a`; Lane B = register `codex/gpt-5.5:medium` with `coreServers: []`; Lane A = add the `:high` grok agent **inside the existing "Lane A passthrough — Grok (KPR-371)" describe** (its beforeEach seeds `GROK_GATEWAY_KEY`).
- **Replay harness:** dispatcher.test.ts outage describe (`replayItem`, `makeTurn`, `store.release`) — reuse as-is.
- **Private-method access:** T6 calls `buildMeetingPreamble` via a typed `as unknown as {…}` cast (precedent: `prepareSpawnSpy`, agent-manager.test.ts:1898).

## Non-Required Rationale

- **No live Slack / live provider E2E** — the mock harnesses pin the full prompt/shaping contract byte-exactly; live proof is the D6 telemetry (deliberately built for it).
- **No Mongo integration tests for the new telemetry fields** — additive optional fields on a schema-less, fail-soft (`withRetry`) store with a TTL bound; the existing store tests cover the write path; T7 pins the input shape at the seam.
- **No provider-adapter or model-router source tests** — both files untouched (spec Integration points).
- **No `docs/providers.md` edit** — see Task 7 conclusion.
- **`conferenceInjectionModeOf` not directly table-tested** — module-private; T7 pins its behavior through the record site (malformed values fall to "key absent", same fail-open family T10 pins for the round helper).

## Verification Rules (dodi-dev:verify)

- Evidence before claims: paste actual vitest/`npm run check` output before marking any step done.
- Negative-verify (Task 6) is mandatory for T1/T3/T4 (spec convention) and extended to T5/T6/T8/T8b — revert the source change, confirm the new test FAILS on pre-fix code, restore, confirm PASS.
- Never run agent-manager tests with `-t`.
- Each commit compiles and its suite passes at commit time (husky/lint-staged will also run).

---

## Tasks

### Task 1 — D1 threading: meta → helpers → TurnContext (Commit 1)

- [ ] **1.1 Dispatcher write side** — `src/channels/dispatcher.ts` `dispatchToAgent` (:1029–1035): add the injection mode to the meta stamp:

```ts
        meta: {
          ...item.meta,
          conferenceMode: true,
          conferenceHumanTs: resolved.conferenceHumanTs,
          conferenceRound: resolved.conferenceRound,
          // KPR-389 D1: injection mode rides along so telemetry can segment
          // full vs delta turns (KPR-388 efficacy measurement).
          conferenceInjectionMode: resolved.injectionMode,
        },
```

- [ ] **1.2 Typed parse helpers** — `src/agents/agent-manager.ts`, module scope (place directly above `const DEFAULT_PER_AGENT_SPAWN_BUDGET`, after the `TurnContext`/`TurnResult` interfaces):

```ts
/** KPR-389: typed read of the dispatcher's conference discriminator (C3 —
 *  meta.conferenceRound is the round-1 discriminator). Returns undefined for
 *  non-conference items and malformed values. Exported — the dispatcher's
 *  D5b single-dispatch suppression leg reads it too. */
export function conferenceRoundOf(item: WorkItem): 0 | 1 | undefined {
  const v = item.meta?.conferenceRound;
  return v === 0 || v === 1 ? v : undefined;
}

/** KPR-389: typed read of the KPR-388 injection mode stamped beside the round. */
function conferenceInjectionModeOf(item: WorkItem): "full" | "delta" | undefined {
  const v = item.meta?.conferenceInjectionMode;
  return v === "full" || v === "delta" ? v : undefined;
}
```

  (`WorkItem` is already imported as a type at the top of the file.)

- [ ] **1.3 TurnContext field** — add to `export interface TurnContext` (after `channel: ChannelKind;`):

```ts
  /** KPR-389: conference turn kind — 0 primary, 1 peer reaction. Set by
   *  runWorkItemTurn from WorkItem meta; undefined for every non-conference
   *  turn and for voice/reflection contexts (which never carry the meta). */
  conferenceRound?: 0 | 1;
```

- [ ] **1.4 Single ingress** — `runWorkItemTurn` (agent-manager.ts:874–882), add to the ctx literal:

```ts
      conferenceRound: conferenceRoundOf(item),
```

  Reflection's ctx builder and voice's direct `spawnTurn` call are untouched (optional field; no meta ⇒ undefined anyway).

- [ ] **1.5 T10** — `src/agents/agent-manager.test.ts`: import `conferenceRoundOf` from `./agent-manager.js` (extend the existing import), add near the other helper describes:

```ts
  describe("conferenceRoundOf (KPR-389 D1)", () => {
    it.each([
      ["round 0", { conferenceRound: 0 }, 0],
      ["round 1", { conferenceRound: 1 }, 1],
      ['malformed string "1"', { conferenceRound: "1" }, undefined],
      ["out-of-range 2", { conferenceRound: 2 }, undefined],
      ["explicit undefined", { conferenceRound: undefined }, undefined],
    ])("%s ⇒ %s", (_label, meta, expected) => {
      expect(conferenceRoundOf(makeWorkItem({ meta: meta as Record<string, unknown> }))).toBe(expected);
    });

    it("missing meta ⇒ undefined (fail-open to full-resource turn, E10)", () => {
      expect(conferenceRoundOf(makeWorkItem())).toBeUndefined();
    });
  });
```

- [ ] **1.6 Shared conference-ctx helper** — module scope in agent-manager.test.ts (beside `makeSmsCtx`), used by Tasks 2/5:

```ts
/** KPR-389: conference-shaped TurnContext + item, meta stamped like the dispatcher does. */
function makeConfCtx(
  round: 0 | 1,
  agentId = "agent-s",
  extraMeta: Record<string, unknown> = {},
): TurnContext & { workItem: WorkItem } {
  const threadId = `conf:${agentId}:${Math.random()}`;
  const workItem = makeWorkItem({
    text: "shaped preamble + transcript + peer reply",
    threadId,
    source: { kind: "slack", id: "C-CONF", label: "conf-tahoe" },
    sender: "U-MAY",
    senderName: "May",
    meta: { conferenceMode: true, conferenceRound: round, ...extraMeta },
  });
  return {
    agentId,
    sessionId: undefined,
    channelId: "C-CONF",
    threadId,
    workItem,
    channel: "slack" as const,
    conferenceRound: round,
  };
}
```

- [ ] **1.7 Verify:**

```bash
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/agents/agent-manager.test.ts
SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/channels/dispatcher-conference.test.ts
npm run typecheck
```

  Expected: all pass (conference suite unchanged — the extra meta key is invisible to existing byte pins, which pin `item.text`, not meta).

- [ ] **1.8 Commit:** `feat(agents): thread conferenceRound + injection mode into TurnContext (KPR-389)`

### Task 2 — D2/D3 round-1 spawn shaping (Commit 2)

- [ ] **2.1 Import** — agent-manager.ts line 13: add `ModelTier` to the model-router import:

```ts
import { routeModel, modelToTier, resolveResourceLimits, type ResourceLimits, type ModelTier } from "./model-router.js";
```

- [ ] **2.2 Constants + method** — add above `prepareSpawn` (module-scope consts + private method after `clampLaneAEffort`):

```ts
/** KPR-389: turn-scoped reaction caps. Template: KPR-354's nested-delegate
 *  literal override (resourceLimits: { maxTurns, timeoutMs: 600_000,
 *  budgetUsd: 0 }); here we clamp with min() instead of replacing so tighter
 *  operator config always wins. maxTurns 6 < KPR-354's 7/10 delegate budgets
 *  (a reaction is strictly lighter); 120s reuses the haiku-tier light-turn
 *  precedent. Plain constants — tune when the D6 telemetry says otherwise. */
const REACTION_MAX_TURNS = 6;
const REACTION_TIMEOUT_MS = 120_000;
```

```ts
  /** KPR-389 D2: round-1 conference reactions spawn cheap — classifier
   *  skipped, effort pinned low where deliverable, limits clamped against the
   *  config-accurate base (exactly what today's turn would have received). */
  private shapeReactionTurn(
    prompt: string,
    staticRoute: ProviderModelRoute,
    staticTier: ModelTier,
    agentConfig: AgentConfig | undefined,
    agentId: string,
  ): SpawnShaping {
    // Degenerate guard (mirrors staticRoute's `?? ""` idiom, E9): agent
    // vanished mid-turn ⇒ flow on; the turn fails inside the recorded try as
    // today (KPR-306 wedged-permit hazard respected).
    if (!agentConfig) {
      return { prompt, route: staticRoute, resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined };
    }
    // Base limits — config-accurate: exactly the values today's turn would
    // otherwise receive, so the min() invariant ("tighter operator config
    // always wins") holds on every reachable path:
    //   claude, router ON:  static-tier limits (resolveResourceLimits). The
    //               legacy triple is dead config there and is deliberately
    //               NOT folded in (folding it would newly activate config
    //               that has no effect today).
    //   claude, router OFF: agent-def legacy triple — today the router gate
    //               returns resourceLimits: undefined and the runner's
    //               per-field fallback applies agentConfig values; operator
    //               tightness may live there (e.g. maxTurns: 3) and must win
    //               the min(). The other undefined-resolving claude paths are
    //               unreachable for round-1: reactions always carry a human
    //               sender (never "system"), and the router-catch cannot fire
    //               because routeModel is never called here.
    //   Lane A + B: agent-def legacy triple (byte-identical to the Lane B
    //               branch construction; for Lane A this newly MATERIALIZES
    //               the same values the runner's per-field fallback would
    //               have applied — no behavior change beyond the clamp).
    const legacy = {
      maxTurns: agentConfig.maxTurns,
      timeoutMs: agentConfig.timeoutMs ?? 300_000,
      budgetUsd: agentConfig.budgetUsd,
    };
    const base =
      staticRoute.provider === "claude" && appConfig.modelRouter.enabled
        ? resolveResourceLimits(staticTier, agentConfig.resourceTiers)
        : legacy;
    const limits: ResourceLimits = {
      maxTurns: Math.min(base.maxTurns, REACTION_MAX_TURNS),
      timeoutMs: Math.min(base.timeoutMs, REACTION_TIMEOUT_MS),
      budgetUsd: base.budgetUsd, // untouched — budget is not the reaction pathology
    };
    // Effort: claude-runtime lanes deliver via Options.effort ("low" is inside
    // the runner's {low,medium,high} narrowing). The claude arm keeps the
    // KPR-338 deliverability gate (haiku / off-catalog ⇒ undefined — pinning
    // an undeliverable hint is a no-op at best). Lane B ignores request.effort
    // by contract (types.ts) ⇒ undefined.
    const effortOverride: ReasoningEffort | undefined =
      staticRoute.provider === "claude"
        ? staticTier !== "haiku" && getLLMRegistry().supportsEffort(agentConfig.model)
          ? "low"
          : undefined
        : isLaneAProvider(staticRoute.provider)
          ? "low"
          : undefined;
    log.debug("Round-1 reaction shaping applied (KPR-389)", {
      agentId,
      maxTurns: limits.maxTurns,
      timeoutMs: limits.timeoutMs,
      effort: effortOverride,
    });
    return { prompt, route: staticRoute, resourceLimits: limits, routerCostUsd: 0, effortOverride };
  }
```

  (`appConfig`, `getLLMRegistry`, `isLaneAProvider`, `ReasoningEffort`, `AgentConfig` are already imported. `AgentConfig` — confirm the import exists at the top of agent-manager.ts; add `type AgentConfig` to the `types/agent-config.js` import if it is not.)

- [ ] **2.3 Branch** — in `prepareSpawn`, insert after the `ctx.sessionHandoff` block (:1700–1709) and **before** the Lane A branch (:1717):

```ts
    // KPR-389: round-1 conference reactions spawn cheap — classifier skipped,
    // effort pinned low where deliverable, limits clamped. Round 0 falls
    // through to every existing path untouched (D3). Voice is structurally
    // unreachable here (carve-out returned above; voice never carries the meta).
    if (ctx.conferenceRound === 1) {
      return this.shapeReactionTurn(prompt, staticRoute, staticTier, agentConfig, ctx.agentId);
    }
```

- [ ] **2.4 Tests T1/T1b/E7/T2/T2b/T3/T4** — new describe in agent-manager.test.ts (T4 goes inside the existing grok describe):

```ts
  describe("round-1 reaction shaping (KPR-389 D2/D3)", () => {
    beforeEach(() => {
      mockConversationIndex.mockResolvedValue(undefined);
    });

    it("T1: round-1 claude effort-capable — classifier skipped, effort low, static-tier base clamped (router on)", async () => {
      (appConfig as any).modelRouter.enabled = true;
      try {
        await manager.spawnTurn(makeConfCtx(1));
        expect(routeModel).not.toHaveBeenCalled();
        const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
        // sonnet base {300s, 50, 5} → min() clamp
        expect(resourceLimits).toEqual({ maxTurns: 6, timeoutMs: 120_000, budgetUsd: 5 });
        expect(effort).toBe("low");
      } finally {
        (appConfig as any).modelRouter.enabled = false;
      }
    });

    it("T1b: round-1 claude router OFF — legacy triple is the base; tighter operator maxTurns wins the min()", async () => {
      registry._agents.set(
        "agent-tight",
        makeAgentConfig({ id: "agent-tight", name: "Tight", model: "claude-sonnet-4-6", maxTurns: 3 }),
      );
      await manager.spawnTurn(makeConfCtx(1, "agent-tight"));
      expect(routeModel).not.toHaveBeenCalled();
      const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
      // base = { maxTurns: 3, timeoutMs: 300_000 (undefined ?? default), budgetUsd: 10 }
      expect(resourceLimits).toEqual({ maxTurns: 3, timeoutMs: 120_000, budgetUsd: 10 });
      expect(effort).toBe("low");
    });

    it("E7: round-1 haiku agent — caps clamp, no effort pin (undeliverable, same as today)", async () => {
      await manager.spawnTurn(makeConfCtx(1, "agent-a")); // agent-a = haiku default fixture
      expect(routeModel).not.toHaveBeenCalled();
      const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
      expect(resourceLimits).toEqual({ maxTurns: 6, timeoutMs: 120_000, budgetUsd: 10 });
      expect(effort).toBeUndefined();
    });

    it("T2: round-0 conference turn untouched — classifier runs, static-tier limits, classifier effort (negative pin, D3)", async () => {
      (appConfig as any).modelRouter.enabled = true;
      try {
        vi.mocked(routeModel).mockResolvedValue(makeRouterResult({ effort: "high" }));
        await manager.spawnTurn(makeConfCtx(0));
        expect(routeModel).toHaveBeenCalledTimes(1);
        const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
        expect(resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
        expect(effort).toBe("high");
      } finally {
        (appConfig as any).modelRouter.enabled = false;
      }
    });

    it("T2b: non-conference control — no meta key ⇒ branch not taken ⇒ today's path byte-unchanged", async () => {
      (appConfig as any).modelRouter.enabled = true;
      try {
        vi.mocked(routeModel).mockResolvedValue(makeRouterResult({ effort: "medium" }));
        await manager.spawnTurn(makeSmsCtx({ agentId: "agent-s" }));
        expect(routeModel).toHaveBeenCalledTimes(1);
        const [, , , , resourceLimits, , effort] = mockRunnerSend.mock.calls[0]!;
        expect(resourceLimits).toEqual(RESOURCE_TIER_DEFAULTS.sonnet);
        expect(effort).toBe("medium");
      } finally {
        (appConfig as any).modelRouter.enabled = false;
      }
    });

    it("T3: Lane B (codex) round-1 — clamped agent-def limits, request.effort undefined; round-0 byte-identical to the Lane B branch", async () => {
      registry._agents.set(
        "codex-conf",
        makeAgentConfig({ id: "codex-conf", name: "CodexConf", model: "codex/gpt-5.5:medium", coreServers: [] }),
      );
      await manager.spawnTurn(makeConfCtx(1, "codex-conf"));
      const req1 = mockCodexRunTurn.mock.calls[0]![0];
      expect(req1.resourceLimits).toEqual({ maxTurns: 6, timeoutMs: 120_000, budgetUsd: 10 });
      expect(req1.effort).toBeUndefined();

      await manager.spawnTurn(makeConfCtx(0, "codex-conf"));
      const req0 = mockCodexRunTurn.mock.calls[1]![0];
      expect(req0.resourceLimits).toEqual({ maxTurns: 25, timeoutMs: 300_000, budgetUsd: 10 });
    });
  });
```

  And inside `describe("Lane A passthrough — Grok (KPR-371)")` (after its existing tests):

```ts
      it("T4 (KPR-389): grok round-1 — 'low' pin overrides the :high suffix, limits materialized+clamped; round-0 keeps suffix + undefined limits", async () => {
        registry._agents.set(
          "agent-grok-high",
          makeAgentConfig({ id: "agent-grok-high", name: "GrokHigh", model: "grok/grok-4.6:high", coreServers: [] }),
        );
        await manager.spawnTurn(makeConfCtx(1, "agent-grok-high"));
        const [, , , , limits1, , effort1] = mockRunnerSend.mock.calls.at(-1)!;
        expect(limits1).toEqual({ maxTurns: 6, timeoutMs: 120_000, budgetUsd: 10 });
        expect(effort1).toBe("low");

        await manager.spawnTurn(makeConfCtx(0, "agent-grok-high"));
        const [, , , , limits0, , effort0] = mockRunnerSend.mock.calls.at(-1)!;
        expect(limits0).toBeUndefined(); // today's Lane A path — runner legacy fallback
        expect(effort0).toBe("high");    // clamped static suffix, today's path
      });
```

- [ ] **2.5 Verify:** whole-file agent-manager run + typecheck. Expected: all pass, incl. the 4 existing "model router resource limits" tests untouched.
- [ ] **2.6 Commit:** `feat(agents): round-1 reaction spawn shaping — classifier skip, low-effort pin, clamped caps (KPR-389)`

### Task 3 — D4 preamble hardening + BOTH pin updates (Commit 3; C6/C10 license exercised here)

- [ ] **3.1 New literal** — replace `buildMeetingPreamble` (dispatcher.ts:1350–1360) with exactly (continuation lines flush-left — the byte pins require it):

```ts
  /** KPR-389 D4: hardened — the transcript is already in prompt ∪ session
   *  (C10 covering-invariant phrasing, true in full AND delta modes); decline
   *  immediately with the C4-safe escape phrase. Escape phrase must stay
   *  "No response needed." verbatim (C4 + C3 terminal-slot coherence) — any
   *  rewording must re-run the C4 guard test. */
  private buildMeetingPreamble(channelName: string, roster: RosterMember[]): string {
    const names = roster.map((r) => r.name).join(", ");
    return `You are in a meeting in #${channelName} with ${names}.

Meeting rules:
- The discussion so far is already in this prompt and your session context — do NOT re-read the channel, search the workspace, or re-orient with tools before speaking.
- If you have nothing meaningful to add, reply "No response needed." immediately — as your first output, with no tool calls first.
- Only use a tool if your reply genuinely needs information that is not already in this thread — never to re-read the meeting itself.
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.`;
  }
```

- [ ] **3.2 T5a — C6 pin update (deliberate)** — dispatcher-conference.test.ts:501–510: replace `expectedPreamble` with the same body (header + blank + rules header + 7 bullets; channel `conf-pin`, name `Jasper`) — the literal below is authoritative, commented:

```ts
    // KPR-389 D4: deliberate C6 pin update — this is the only ticket licensed
    // to edit this literal (epic canon C6). Full-join byte identity retained.
    const expectedPreamble = `You are in a meeting in #conf-pin with Jasper.

Meeting rules:
- The discussion so far is already in this prompt and your session context — do NOT re-read the channel, search the workspace, or re-orient with tools before speaking.
- If you have nothing meaningful to add, reply "No response needed." immediately — as your first output, with no tool calls first.
- Only use a tool if your reply genuinely needs information that is not already in this thread — never to re-read the meeting itself.
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.`;
```

  The final assertion (`${expectedPreamble}\n---\n[New message]:\n${item.text}`) is unchanged — full-join byte pin stays as strict as before.

- [ ] **3.3 T5b — C10 `PREAMBLE` helper update (deliberate)** — :516–523: same body, parameterized `#${channel}` / `${names}`, with a `// KPR-389 D4: deliberate C10 pin update (see C6 note above).` comment. The delta pin (:585–587), empty-delta pin (:941), and reviewer pins (:947+) update transitively — verify they still assert the **full join shape** (they do; only the helper literal changes).
- [ ] **3.4 Stale-literal grep** — confirm no other embedding of the old preamble text:

```bash
grep -rn "If you have nothing meaningful to add, respond with" src/ seeds/ || echo CLEAN
# scoped to src/ + seeds/ — docs/ keeps two permanent historical hits (kpr-388-plan.md quoting the old preamble, and this plan itself); CLEAN is expected only for the scoped form
```

  Expected: `CLEAN` after the edits (the old preamble line is the only user of that exact wording). Note the C3 terminal slot at dispatcher.ts:1020–1023 uses the DIFFERENT phrase `If you have nothing to add, respond with "No response needed."` ("nothing to add", not "nothing meaningful to add") — it will not match this grep, is C3-byte-intact, and must NOT be touched.

- [ ] **3.5 T6 — C4 structural guard** — add to dispatcher-conference.test.ts (top-level describe, after the pin test):

```ts
  it("T6 (C4 guard): a double-quoted escape phrase in the preamble matches NON_RESPONSE_PATTERNS", () => {
    // Local mirror of dispatcher.ts NON_RESPONSE_PATTERNS — same deliberate-copy
    // convention as dispatcher.test.ts:273 (the pin IS the point: widen-or-match
    // is enforced by this test failing on any preamble rewording).
    const NON_RESPONSE_PATTERNS = [
      /^no response (requested|needed|required|necessary)\.?$/i,
      /^\(no response\)$/i,
      /^n\/a\.?$/i,
    ];
    const preamble = (
      dispatcher as unknown as {
        buildMeetingPreamble(c: string, r: Array<{ agentId: string; name: string; title?: string; role: string }>): string;
      }
    ).buildMeetingPreamble("x", [{ agentId: "jasper", name: "Jasper", role: "VP Engineering" }]);
    const quoted = [...preamble.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(quoted.length).toBeGreaterThan(0);
    expect(quoted.some((p) => NON_RESPONSE_PATTERNS.some((rx) => rx.test(p.trim())))).toBe(true);
  });
```

- [ ] **3.6 Verify:** conference suite whole-file — all 28 + T6 pass. The spec's deviation note stands: the ticket's `"(no response)"` literal is deliberately NOT adopted (C3/C4 coherence — `NON_RESPONSE_PATTERNS[1]` keeps it as drift tolerance only).
- [ ] **3.7 Commit:** `feat(dispatcher): harden meeting preamble against tool re-orientation; deliberate C6/C10 pin updates (KPR-389)`

### Task 4 — D5 + D5b kill suppression + round-tagged suppression logs (Commit 4)

- [ ] **4.1 Import** — dispatcher.ts line 5: convert to a mixed import (adds the one value; no cycle — agent-manager imports nothing from `channels/`):

```ts
import {
  conferenceRoundOf,
  type AgentManager,
  type TurnContext,
  type TurnResult,
  type SpawnTurnStreamCallback,
} from "../agents/agent-manager.js";
```

- [ ] **4.2 D5 fan-out guard** — in `dispatchToAgent`, AFTER the KPR-388 mark-bookkeeping block (:1072–1083) and BEFORE `const trimmedText` (:1085):

```ts
      // KPR-389 D5: a killed reaction is silent — never post filler into the
      // meeting. Keys on the in-memory ResolvedAgent (replay items never carry
      // conference fields here — they take the single-dispatch leg, D5b). The
      // early return deliberately skips recordTurnSuccess: a killed turn is
      // not evidence of provider recovery (the KPR-307 episode ends on the
      // next genuinely successful turn). An errored reaction WITH text still
      // delivers (exit-code-1 convention — may be a real answer + warning).
      if (
        resolved.conferenceRound === 1 &&
        (runResult.aborted || runResult.timedOut || (runResult.error && !runResult.text.trim()))
      ) {
        log.info("Round-1 reaction suppressed (killed/errored)", {
          agentId,
          aborted: runResult.aborted,
          timedOut: runResult.timedOut,
          error: runResult.error?.slice(0, 120),
        });
        return;
      }
```

- [ ] **4.3 Fan-out suppression log round tag** — :1089 becomes:

```ts
        log.info("Non-response suppressed (fan-out)", { agentId, conferenceRound: resolved.conferenceRound });
```

  (a number — redaction-safe; this is the §C5 trigger's numerator field.)

- [ ] **4.4 D5b single-dispatch leg** — in the `dispatch()` single-dispatch body, after `isNonResponse` (:324) restructure the delivery branch to `if / else if / else`:

```ts
      const trimmedText = runResult.text.trim();
      const isNonResponse = NON_RESPONSE_PATTERNS.some((p) => p.test(trimmedText));

      // KPR-389 D5b: single-dispatch leg of the round-1 kill suppression —
      // reachable only by replayed reactions (live conference turns always
      // route via dispatchToAgent). Discriminator is the meta (replay
      // `resolved` carries no conference fields). Delivery-only suppression:
      // recordTurnSuccess below still runs, so replay → done resolution is
      // unharmed. Text-bearing kills DELIVER here, unlike the fan-out leg —
      // replay is the last delivery chance. No error arm: an errored replay
      // already resolved via resolveReplayRealFailure above.
      const killedReaction =
        conferenceRoundOf(item) === 1 && (runResult.aborted || runResult.timedOut) && !trimmedText;

      if (isNonResponse) {
        log.info("Non-response suppressed", {
          agentId,
          source: item.source.kind,
          text: trimmedText,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
          conferenceRound: conferenceRoundOf(item),
        });
      } else if (killedReaction) {
        log.info("Round-1 reaction suppressed on replay (killed)", {
          agentId,
          aborted: runResult.aborted,
          timedOut: runResult.timedOut,
        });
      } else {
        // …existing delivery block, byte-unchanged…
      }
```

  `recordTurnSuccess` (:373–375) stays exactly as-is below the branch.

- [ ] **4.5 T8** — dispatcher-conference.test.ts, new describe inside the main harness describe:

```ts
  describe("round-1 kill suppression (KPR-389 D5)", () => {
    const zeroUsage = {
      inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
      contextWindow: 0, costUsd: 0, durationMs: 100,
    };
    function turn(overrides: Record<string, unknown> = {}) {
      return {
        finalMessage: "Agent response", newSessionId: "s2", usage: zeroUsage, errors: [],
        llmMs: 0, toolMs: 0, toolCalls: 0, toolSummary: null, streamed: false, compactions: 0,
        ...overrides,
      };
    }
    async function twoAgentClassifier() {
      const { classifyMeetingMessage } = await import("../agents/meeting-classifier.js");
      (classifyMeetingMessage as any)
        .mockResolvedValueOnce({ respondAgentIds: ["jasper"], costUsd: 0.001, durationMs: 100 })
        .mockResolvedValue({ respondAgentIds: ["jessica"], costUsd: 0.001, durationMs: 100 });
    }
    function confItem(threadId: string) {
      return makeWorkItem({
        text: "Jasper, and Jessica, please weigh in",
        source: { kind: "slack", id: "C-CONF", label: "conf-kill" },
        threadId,
        meta: { slackTs: "1700.0001" },
      });
    }

    it.each([
      ["aborted", { aborted: true }],
      ["timedOut", { timedOut: true, aborted: true }],
    ])("killed round-1 reaction (%s) never delivers; mark untouched for the reactor", async (_label, flags) => {
      await twoAgentClassifier();
      agentManager.runWorkItemTurn
        .mockResolvedValueOnce(turn()) // jasper round-0: real reply
        .mockResolvedValueOnce(turn({ finalMessage: "", ...flags })); // jessica round-1: killed
      await dispatcher.dispatch(confItem(`conf-kill-${_label}`));
      await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
      expect(adapter.deliver).toHaveBeenCalledTimes(1); // only jasper's round-0 reply
      expect(adapter.deliver.mock.calls[0][0].agentId).toBe("jasper");
      expect(agentManager._sessionStore.setMeetingMark).not.toHaveBeenCalledWith(
        "jessica", expect.anything(), expect.anything(),
      );
    });

    it("errored round-1 reaction WITH text still delivers (exit-code-1 convention)", async () => {
      await twoAgentClassifier();
      agentManager.runWorkItemTurn
        .mockResolvedValueOnce(turn())
        .mockResolvedValueOnce(turn({ finalMessage: "Real answer with a warning", errors: ["exit 1"] }));
      await dispatcher.dispatch(confItem("conf-kill-errtext"));
      await vi.waitFor(() => expect(agentManager.runWorkItemTurn).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(adapter.deliver).toHaveBeenCalledTimes(2));
      expect(adapter.deliver.mock.calls[1][0].text).toBe("Real answer with a warning");
    });

    it("control: a killed ROUND-0 turn keeps today's delivery behavior (filler delivered)", async () => {
      await soloClassifier(); // round-0 jasper only, reaction pass selects nobody
      agentManager.runWorkItemTurn.mockResolvedValueOnce(turn({ finalMessage: "", aborted: true }));
      await dispatcher.dispatch(
        makeWorkItem({
          text: "Jasper, next steps?",
          source: { kind: "slack", id: "C-CONF", label: "conf-kill-r0" },
          threadId: "conf-kill-r0",
          meta: { slackTs: "1700.0002" },
        }),
      );
      expect(adapter.deliver).toHaveBeenCalledTimes(1);
      expect(adapter.deliver.mock.calls[0][0].text).toBe("_No response._");
    });
  });
```

  (`soloClassifier` lives inside the delta describe — either place this describe there or hoist `soloClassifier` one level; hoisting is fine, it only touches the classifier mock.)

- [ ] **4.6 T8b + T9** — dispatcher.test.ts, inside `describe("outage interception (KPR-307)")`:

```ts
  it("T8b (KPR-389 D5b): replayed killed reaction — delivery suppressed, replay doc still resolves done", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "", aborted: true, timedOut: true }),
    );
    await dispatcher.dispatch(
      replayItem({ id: "m1", meta: { outageReplay: true, targetAgentId: "executive-assistant", conferenceRound: 1 } }),
    );
    expect(adapter.deliver).not.toHaveBeenCalled(); // no "_No response._" filler into the meeting
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "done"); // recordTurnSuccess intact
  });

  it("T8b variant: a TEXT-BEARING killed replay still delivers (replay is the last delivery chance)", async () => {
    agentManager.runWorkItemTurn.mockResolvedValueOnce(
      makeTurn({ finalMessage: "partial but real", aborted: true, timedOut: true }),
    );
    await dispatcher.dispatch(
      replayItem({ id: "m1", meta: { outageReplay: true, targetAgentId: "executive-assistant", conferenceRound: 1 } }),
    );
    expect(adapter.deliver).toHaveBeenCalledTimes(1);
    expect(adapter.deliver.mock.calls[0][0].text).toBe("partial but real");
  });

  it("T8b control: replayed reaction with a clean result delivers normally and resolves done", async () => {
    await dispatcher.dispatch(
      replayItem({ id: "m1", meta: { outageReplay: true, targetAgentId: "executive-assistant", conferenceRound: 1 } }),
    );
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // default mock returns real text
    expect(store.release).toHaveBeenCalledWith("m1", "executive-assistant", "done");
  });

  it("T9 (KPR-389): replay retains meta.conferenceRound through the pinned-agent path (shaping re-applies downstream)", async () => {
    await dispatcher.dispatch(
      replayItem({ id: "m1", meta: { outageReplay: true, targetAgentId: "executive-assistant", conferenceRound: 1 } }),
    );
    const [, turnItem] = agentManager.runWorkItemTurn.mock.calls[0];
    expect(turnItem.meta?.conferenceRound).toBe(1); // conferenceRoundOf ⇒ 1 in prepareSpawn (T1 covers the shaping itself)
    expect(adapter.deliver).toHaveBeenCalledTimes(1); // D5 fan-out guard did NOT fire (replay resolved bare)
  });
```

  (Check the outage describe's `makeMockAgentManager` default `runWorkItemTurn` result text before writing the control assertions — mirror whatever real-text default it uses.)

- [ ] **4.7 Verify:** conference + dispatcher suites whole-file. Expected all green; the E4 nit applies — replayed text is `replayWrap`'d, so never pin bare shaped text on replayed items (T9 pins meta, not text).
- [ ] **4.8 Commit:** `feat(dispatcher): suppress killed round-1 reactions on fan-out and replay legs (KPR-389)`

### Task 5 — D6 telemetry stamping (Commit 5)

- [ ] **5.1 `turn-telemetry.ts`** — append to BOTH `TurnTelemetryDoc` and `TurnTelemetryInput` (before `createdAt` in the doc):

```ts
  // KPR-389: turn-kind + perf split for conference before/after measurement.
  conferenceRound?: number; // 0 | 1; absent on non-conference turns
  injectionMode?: "full" | "delta"; // KPR-388 injection mode, from meta
  resumedSession?: boolean; // C7 — finalized attempt launched with a handle
  durationMs?: number;
  llmMs?: number;
  toolMs?: number;
  toolCalls?: number;
  effort?: string; // delivered effortOverride ("low" pin visible)
```

  `hitRatesByAgent` and both indexes untouched.

- [ ] **5.2 `activity/types.ts`** — add to `ActivityRecord` (Outcome section):

```ts
  /** KPR-389: conference turn kind — 0 primary, 1 peer reaction; absent on
   *  non-conference turns. Kills/errors DO reach this log (unlike turn
   *  telemetry), keeping reaction kill counts measurable. */
  conferenceRound?: number;
```

- [ ] **5.3 `recordSpawnObservability`** — agent-manager.ts:1819: add the 4th param and stamps:

```ts
  private recordSpawnObservability(
    ctx: TurnContext,
    shaping: SpawnShaping,
    result: RunResult,
    resumedSession: boolean,
  ): void {
    const item = ctx.workItem;
    // KPR-389 D6: turn-kind discriminators from the dispatcher's conference meta.
    const confRound = conferenceRoundOf(item);
    const injectionMode = conferenceInjectionModeOf(item);
```

  Inside the existing `record({ … })` call (after `ephemeral1hTokens`), add:

```ts
          // KPR-389: perf split + turn kind (conditional spreads keep absent
          // keys absent — no BSON nulls on non-conference turns).
          durationMs: result.durationMs,
          llmMs: result.llmMs,
          toolMs: result.toolMs,
          toolCalls: result.toolCalls,
          resumedSession,
          ...(shaping.effortOverride ? { effort: shaping.effortOverride } : {}),
          ...(confRound !== undefined ? { conferenceRound: confRound } : {}),
          ...(injectionMode ? { injectionMode } : {}),
```

  Inside the `activityLogger?.record({ … })` call (after `error: result.error,`), add:

```ts
      ...(confRound !== undefined ? { conferenceRound: confRound } : {}),
```

- [ ] **5.4 Call site** — agent-manager.ts:1123:

```ts
      this.recordSpawnObservability(effectiveCtx, shaping, finalResult, !!finalAttemptSessionId);
```

- [ ] **5.5 T7/T7b/T7c** — agent-manager.test.ts:

```ts
  describe("turn-kind telemetry (KPR-389 D6)", () => {
    function makeActivityLogger() {
      return { record: vi.fn() };
    }
    function buildManager(activityLogger: { record: ReturnType<typeof vi.fn> }) {
      return new AgentManager(
        registry as any, memoryManager as any, sessionStore as any,
        undefined as any, turnTelemetryStore as any, activityLogger as any,
      );
    }

    beforeEach(() => {
      mockConversationIndex.mockResolvedValue(undefined);
    });

    it("T7: round-1 conference turn stamps round, injectionMode, resumedSession, perf split, effort — telemetry AND activity", async () => {
      const activityLogger = makeActivityLogger();
      const mgr = buildManager(activityLogger);
      const { workItem, threadId } = makeConfCtx(1, "agent-s", { conferenceInjectionMode: "delta" });
      // Seed a resumable same-provider session so runWorkItemTurn resolves it
      // (C7: resumedSession = the finalized attempt launched with a handle).
      sessionStore._sessions.set(`agent-s:${threadId}`, { sessionId: "sess-live", provider: "claude" });

      await mgr.runWorkItemTurn("agent-s", workItem);

      expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
      const doc = turnTelemetryStore.record.mock.calls[0][0];
      expect(doc).toMatchObject({
        conferenceRound: 1,
        injectionMode: "delta",
        resumedSession: true,
        durationMs: 1000, // makeRunResult defaults
        llmMs: 800,
        toolMs: 200,
        toolCalls: 1,
        effort: "low", // the D2 pin, visible in telemetry
      });
      expect(activityLogger.record.mock.calls[0][0].conferenceRound).toBe(1);
    });

    it("T7b: plain DM turn — perf fields present, conference keys ABSENT", async () => {
      await manager.spawnTurn(makeSmsCtx({ agentId: "agent-s" }));
      const doc = turnTelemetryStore.record.mock.calls[0][0];
      expect(doc.durationMs).toBe(1000);
      expect(doc.resumedSession).toBe(false);
      expect(doc).not.toHaveProperty("conferenceRound");
      expect(doc).not.toHaveProperty("injectionMode");
      expect(doc).not.toHaveProperty("effort"); // router off ⇒ no override on a DM turn
    });

    it("T7c: an aborted (clamp-killed) reaction skips turn telemetry but lands round-tagged in the activity log", async () => {
      const activityLogger = makeActivityLogger();
      const mgr = buildManager(activityLogger);
      mockRunnerSend.mockResolvedValueOnce(makeRunResult({ aborted: true, text: "", timedOut: true }));

      await mgr.runWorkItemTurn("agent-s", makeConfCtx(1, "agent-s").workItem);

      expect(turnTelemetryStore.record).not.toHaveBeenCalled(); // !aborted gate
      expect(activityLogger.record.mock.calls[0][0].conferenceRound).toBe(1); // kills stay measurable (C5 volume counter)
    });
  });
```

- [ ] **5.6 Verify:** whole-file agent-manager run + typecheck. Watch for existing tests that spy on `recordSpawnObservability`'s call shape — grep the suite for direct references (`grep -n "recordSpawnObservability" src/agents/agent-manager.test.ts`); the arity change is internal-private so only such spies could break.
- [ ] **5.7 Commit:** `feat(telemetry): conferenceRound, injection mode, resumedSession + perf split on turn telemetry and activity log (KPR-389)`

### Task 6 — Negative-verify pass (no commit; transcript required)

For each row: apply the temporary revert, run the named suite, confirm the named tests FAIL (and only in the expected way), restore (`git checkout -- <file>` or undo the comment), re-run, confirm PASS.

| Revert (temporary) | Expected FAIL | Expected failure mode |
|---|---|---|
| Comment out the `ctx.conferenceRound === 1` branch in `prepareSpawn` (Task 2.3) | T1, T1b, E7, T3 round-1 half, T4 round-1 half, T7 (`effort: "low"` missing) | Immediate assertion diffs: `routeModel` called (T1/T2 spy count), limits = tier defaults / undefined instead of clamped, effort = classifier/suffix value |
| Restore the OLD preamble literal in `buildMeetingPreamble` (keep new pins) | C6 pin test, delta pin, empty-delta pin, T6 | Byte-pin string diffs; T6 fails only if the old literal's quoted phrase were also removed — expect T6 to PASS on this revert (old literal also quotes the C4 phrase); note that in the transcript |
| Comment out the D5 fan-out guard (Task 4.2) | T8 both `it.each` variants | `deliver` called 2× instead of 1× — immediate diff. NOTE the waitFor-timeout failure mode: the `waitFor` on `runWorkItemTurn × 2` still passes; only the synchronous deliver-count assert fails. If instead a `waitFor` wrapped a never-true expectation it would fail SLOWLY as "waitFor timed out" wrapping the real assertion error — read the nested error, don't chase the timeout |
| Comment out the D5b `else if (killedReaction)` leg (Task 4.4) | T8b (filler delivered) | `deliver` called with `"_No response._"`; `release(...,"done")` still passes (behavior-preserving half) |

Behavior-preserving expected-PASS set (must stay green on every revert EXCEPT its own): T2/T2b, all pre-existing 28 conference tests (modulo the two pin literals), dispatcher.test.ts existing suite, "replay success releases done", full agent-manager suite.

- [ ] Record each revert → FAIL → restore → PASS cycle in the implementation transcript (dodi-dev:verify evidence).

### Task 7 — Full sweep, bundle guards, providers.md check (commit only if fixes emerge)

- [ ] **7.1** `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check` — expect exit 0 (typecheck + lint + format + full vitest). If Prettier rewrites the new template literals, re-run the byte-pin suites afterward (flush-left continuation lines must survive formatting — template-literal interiors are not reformatted by Prettier, but verify).
- [ ] **7.2** `npm run check:bundle` — expect bundle + all 4 guards green (no new externals were introduced; this is belt-and-braces).
- [ ] **7.3 `docs/providers.md` check** — read row 12 + footnote 12. **Conclusion (state in PR body for reviewer confirmation, per spec):** no edit required. Row 12's claude cell ("full — per-turn classifier, catalog-driven") describes provider *capability*; KPR-389 skips the classifier only for round-1 conference reaction turns as a hive turn-shaping policy, and the Lane B "effort unchanged on reactions" is the pre-existing constructor-time-suffix contract, not a new behavioral divergence. `maxTurns`/`timeoutMs` clamping uses the existing per-turn resource-limits channel footnote 10 already documents. If the reviewer disagrees, the fix is a one-line footnote-12 addendum — file it as a review fix, not a scope change.
- [ ] **7.4** Confirm the diff touches ONLY: `src/channels/dispatcher.ts`, `src/agents/agent-manager.ts`, `src/agents/turn-telemetry.ts`, `src/activity/types.ts`, `src/channels/dispatcher-conference.test.ts`, `src/channels/dispatcher.test.ts`, `src/agents/agent-manager.test.ts` (`git diff --stat 5029b07 -- src/`). Anything else under src/ = scope leak — stop and re-check. (Unscoped diff also shows the plan/manifest docs commits — expected, not a leak.)

---

## Out-of-scope guard rails (do NOT touch)

- **KPR-390:** `buildConferenceContext`'s full-injection arm (C13 anchor site), scribe/summary anchoring.
- **Staleness culling** (skipping queued reactions on newer human messages) — deferred with an explicit telemetry trigger (spec Non-goals).
- **Per-turn tool-inventory restriction** for reactions — YAGNI until data.
- **Lane B per-turn effort delivery** — adapters keep ignoring `request.effort`; no provider-adapter file changes at all.
- **Meeting classifier** (`classifyMeetingMessage`), incl. the C5 lone-peer shortcut (dispositioned measure-first) and C1 all-roster fallbacks.
- **Round-0 shaping of any kind** — the preamble text change is the sole round-0-visible diff, licensed by D4 + the C6 pin update.
- **C3 terminal slot** (dispatcher.ts:1020–1023 reaction framing) — byte-intact.
- Session store, outage machinery, `AgentRunner`, model-router source, mark bookkeeping placement (C12).
- The pre-existing shuffle-order-dependent KPR-387 conference test — leave it.

## Commit summary (5 code commits + verification)

1. `feat(agents): thread conferenceRound + injection mode into TurnContext (KPR-389)`
2. `feat(agents): round-1 reaction spawn shaping — classifier skip, low-effort pin, clamped caps (KPR-389)`
3. `feat(dispatcher): harden meeting preamble against tool re-orientation; deliberate C6/C10 pin updates (KPR-389)`
4. `feat(dispatcher): suppress killed round-1 reactions on fan-out and replay legs (KPR-389)`
5. `feat(telemetry): conferenceRound, injection mode, resumedSession + perf split on turn telemetry and activity log (KPR-389)`

Each commit carries its tests (repo convention: tests along the way); Tasks 6–7 are verification-only.
