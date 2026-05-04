# Prompt Cache Observability Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Add per-turn cache telemetry persistence and a `hive doctor` "Prompt cache" section so we can measure prompt-cache hit rate per agent over the trailing 7 days before deciding whether to restructure systemPrompt assembly.

**Architecture:** A new `agent_turn_telemetry` MongoDB collection captures one document per agent turn (written fail-soft from `AgentManager` alongside the existing `sessionStore.set` call). A pure aggregator function reads the collection and emits per-agent hit-rate rows for a configurable window. `hive doctor` calls the aggregator and prints a "Prompt cache" section after the existing groups. Ephemeral 5m/1h cache breakdown is captured opportunistically from `SDKResultMessage.usage.cache_creation` (verified reachable via the upstream `BetaCacheCreation` type).

**Tech Stack:** TypeScript (strict), MongoDB (TTL index, aggregation pipeline), Vitest, existing logger / Mongo / SDK patterns.

## Testing Contract

### Required Test Groups
- Unit: required — Scope: `agent-runner` ephemeral extraction + `RunResult` shape, `AgentManager` post-turn write to telemetry collection, aggregator math (hit rate, no-data, divide-by-zero), `doctor-checks` prompt-cache aggregator, `doctor` rendering of the new section. Min assertions: ≥1 per public branch (extracted-on-success, extracted-with-ephemeral, missing-usage, no-rows, all-zero-counters, single-agent, multi-agent, formula correctness).
- Integration: not-required — Reason: aggregator is a pure read over a Mongo collection; integration with a live Mongo is covered by the operator follow-through (running the engine for a window and observing real telemetry, tracked separately per the spec). Adding a dockerised mongod harness for one collection inflates scope past spec.
- E2E: not-required — Reason: spec is "measure first via `hive doctor`"; the operator-side step (run a hive 7 days, post audit memo) is explicitly tracked separately and does not gate ticket close.

### Critical Flows / Regression Surface / Commands / Harness Requirements / Non-Required Rationale

**Critical flows covered by unit tests:**
1. Per-turn telemetry write happens after every successful `runner.send` (parallel to `sessionStore.set`) and is fail-soft — Mongo errors must not break the turn.
2. Aggregator returns one row per agent for the requested window.
3. `hitRate = cacheReadTokens / (cacheReadTokens + cacheCreationTokens + inputTokens)` — verifies `inputTokens` is the *uncached* counter, not a sum.
4. No-data row (zero turns) and all-zero-counter row (turns happened but every counter was 0) both render as "no data" rather than "0%".
5. Ephemeral 5m/1h fields are persisted only when `usage.cache_creation` is present; absence does not crash extraction.
6. `hive doctor` prints the "Prompt cache" section with per-agent rows in a stable order.

**Regression surface to watch:**
- `AgentManager.processThreadQueue` post-turn block (`agent-manager.ts:294-304`) — must keep `sessionStore.set` behavior intact when adding the telemetry write.
- `RunResult` shape (`agent-runner.ts:50-69`) — additive only; no existing field renamed.
- `runDoctor` exit-code semantics — the new section is informational and must not contribute to the `allPassed` decision.

**Commands:**
- `npm run test -- src/agents/agent-runner.test.ts` — token extraction unit
- `npm run test -- src/agents/agent-manager.test.ts` — post-turn write unit
- `npm run test -- src/agents/turn-telemetry.test.ts` — new aggregator unit
- `npm run test -- src/cli/doctor-checks.test.ts` — aggregator wiring unit
- `npm run test -- src/cli/doctor.test.ts` — rendering unit
- `npm run check` — typecheck + lint + format + test gate

**Harness Requirements:** None beyond Vitest's built-in mocking. Mongo is mocked the same way `doctor-checks.test.ts` already does it (vi.mock("mongodb")).

**Non-Required Rationale:**
- Integration: aggregator is single-collection / single-pipeline; unit-mock of the Mongo client is faithful to the actual call shape. A real Mongo harness would not exercise additional code paths.
- E2E: the spec splits "ship code" (this ticket) from "post audit memo" (operator follow-through tracked separately). E2E would mean spinning a hive for 7 days, which is expressly out-of-scope.

### Verification Rules
- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

### Task 1: Extract ephemeral cache breakdown in AgentRunner
**Files:**
- Modify `/Users/mokie/github/hive/src/agents/agent-runner.ts` (extend `RunResult` interface around lines 50-69, extend extraction at lines 1453-1458, extend log line at 1530-1548, extend return at 1550-1557).
- Modify `/Users/mokie/github/hive/src/agents/agent-runner.test.ts` (add ephemeral-extraction tests next to the existing token-tracking block ~line 1511).

- [ ] **Step 1:** In `agent-runner.ts`, extend the `RunResult` interface to add two optional fields directly after `cacheCreationTokens` (around line 63):
      ```typescript
        cacheCreationTokens: number;
        ephemeral5mTokens?: number; // From usage.cache_creation.ephemeral_5m_input_tokens; undefined if SDK omits it.
        ephemeral1hTokens?: number; // From usage.cache_creation.ephemeral_1h_input_tokens; undefined if SDK omits it.
        contextWindow: number;
      ```
- [ ] **Step 2:** In `agent-runner.ts`, declare the two new locals immediately after the existing token-var block at lines 1349-1351 (`let inputTokens = 0; let outputTokens = 0; let cacheReadTokens = 0; let cacheCreationTokens = 0;`). Default to `undefined` so "SDK omitted the field" is distinguishable from "field present but zero":
      ```typescript
        let ephemeral5mTokens: number | undefined;
        let ephemeral1hTokens: number | undefined;
      ```
- [ ] **Step 3:** In `agent-runner.ts` extraction block (lines 1453-1458), extend the `if (usage)` block to read `usage.cache_creation` opportunistically. Reachability is confirmed via `BetaCacheCreation` in `node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts` — `SDKResultMessage.usage` is `NonNullableUsage`, which is `BetaUsage` with all fields non-nullable, but `cache_creation` is itself a structural object that older SDK versions may emit as `null`. Treat absence as "not surfaced":
      ```typescript
            cacheReadTokens = usage.cache_read_input_tokens ?? 0;
            cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
            // Cache-creation breakdown by TTL class. SDK type:
            //   node_modules/@anthropic-ai/sdk/resources/beta/messages/messages.d.ts (BetaCacheCreation).
            // Older SDK versions emit `cache_creation: null` — treat as "not surfaced," do not record zeros.
            const cc = (usage as any).cache_creation;
            if (cc && typeof cc === "object") {
              ephemeral5mTokens = typeof cc.ephemeral_5m_input_tokens === "number" ? cc.ephemeral_5m_input_tokens : undefined;
              ephemeral1hTokens = typeof cc.ephemeral_1h_input_tokens === "number" ? cc.ephemeral_1h_input_tokens : undefined;
            }
      ```
- [ ] **Step 4:** In `agent-runner.ts` extend the `log.info("Agent response complete", { ... })` (lines 1530-1548) to include the two new fields and the return at lines 1550-1557 to surface them:
      ```typescript
          log.info("Agent response complete", {
            agent: this.agentConfig.id,
            // ...existing fields...
            cacheReadTokens,
            cacheCreationTokens,
            ephemeral5mTokens,
            ephemeral1hTokens,
            contextWindow,
            // ...
          });

          return {
            text: resultText, sessionId: resultSessionId, costUsd, durationMs,
            llmMs, toolMs: totalToolMs, toolCalls: toolCalls.length,
            toolSummary: toolSummary || "none", streamed,
            inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens,
            ephemeral5mTokens, ephemeral1hTokens,
            contextWindow, compactions, preCompactTokens,
            error, aborted: this._aborted,
          };
      ```
- [ ] **Step 5:** In `agent-runner.test.ts`, add two new tests inside the existing `describe("AgentRunner token tracking and compaction (via send)", ...)` block (~line 1512):
      ```typescript
        it("extracts ephemeral 5m/1h breakdown when SDK surfaces cache_creation", async () => {
          mockMessages = [{
            type: "result",
            subtype: "success",
            result: "response",
            total_cost_usd: 0.01,
            duration_ms: 200,
            session_id: "s1",
            usage: {
              input_tokens: 1500,
              output_tokens: 300,
              cache_read_input_tokens: 500,
              cache_creation_input_tokens: 200,
              cache_creation: {
                ephemeral_5m_input_tokens: 150,
                ephemeral_1h_input_tokens: 50,
              },
            },
          }];
          const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
          const result = await runner.send("hello");
          expect(result.ephemeral5mTokens).toBe(150);
          expect(result.ephemeral1hTokens).toBe(50);
        });

        it("leaves ephemeral fields undefined when SDK does not surface cache_creation", async () => {
          mockMessages = [{
            type: "result",
            subtype: "success",
            result: "response",
            total_cost_usd: 0.01,
            duration_ms: 200,
            session_id: "s1",
            usage: {
              input_tokens: 100,
              output_tokens: 50,
              cache_read_input_tokens: 10,
              cache_creation_input_tokens: 5,
              // no cache_creation field
            },
          }];
          const runner = new AgentRunner(makeAgentConfig(), memoryManager as any);
          const result = await runner.send("hello");
          expect(result.ephemeral5mTokens).toBeUndefined();
          expect(result.ephemeral1hTokens).toBeUndefined();
        });
      ```
- [ ] **Step 6:** Verify — `npm run test -- src/agents/agent-runner.test.ts` should pass with all existing token-tracking tests plus the two new ephemeral tests. Expected output ends with `Test Files  1 passed` and the file's existing test count + 2.
- [ ] **Step 7:** Commit — `git add src/agents/agent-runner.ts src/agents/agent-runner.test.ts && git commit -m "agent-runner: surface ephemeral 5m/1h cache breakdown in RunResult"`

---

### Task 2: Add `TurnTelemetryStore` (per-turn collection writer + aggregator)
**Files:**
- Create `/Users/mokie/github/hive/src/agents/turn-telemetry.ts`
- Create `/Users/mokie/github/hive/src/agents/turn-telemetry.test.ts`

- [ ] **Step 1:** Write `src/agents/turn-telemetry.ts` modelled on `session-store.ts` (same `withRetry` fail-soft pattern). Collection name: `agent_turn_telemetry`. TTL index 14 days on `createdAt`. Includes the aggregator that returns per-agent hit-rate rows for a given window.
      ```typescript
      import { type Collection, type Db } from "mongodb";
      import { createLogger } from "../logging/logger.js";

      const log = createLogger("turn-telemetry");

      export interface TurnTelemetryDoc {
        agentId: string;
        threadId: string;
        sessionId: string;
        model?: string;
        inputTokens: number; // Uncached new input only — disjoint from cache_read/cache_creation.
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        ephemeral5mTokens?: number;
        ephemeral1hTokens?: number;
        createdAt: Date;
      }

      export interface TurnTelemetryInput {
        agentId: string;
        threadId: string;
        sessionId: string;
        model?: string;
        inputTokens: number;
        outputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        ephemeral5mTokens?: number;
        ephemeral1hTokens?: number;
      }

      export interface CacheHitRateRow {
        agentId: string;
        turns: number;
        inputTokens: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        ephemeral5mTokens: number;
        ephemeral1hTokens: number;
        // Null when the row has no measurable input (no turns OR all three counters zero).
        // Renderers translate null to "no data" rather than "0%".
        hitRate: number | null;
      }

      export class TurnTelemetryStore {
        private collection!: Collection<TurnTelemetryDoc>;

        constructor(private db: Db) {}

        async init(): Promise<void> {
          this.collection = this.db.collection<TurnTelemetryDoc>("agent_turn_telemetry");
          // 14 days = one full 7-day measurement window plus headroom; keeps the collection bounded.
          await this.collection.createIndex({ createdAt: 1 }, { expireAfterSeconds: 14 * 24 * 60 * 60 });
          await this.collection.createIndex({ agentId: 1, createdAt: -1 });
          log.info("Turn telemetry store connected");
        }

        private async withRetry<T>(op: () => Promise<T>, fallback: T, label: string): Promise<T> {
          try {
            return await op();
          } catch (err: any) {
            log.error("MongoDB operation failed, using fallback", { label, error: String(err?.message ?? err) });
            return fallback;
          }
        }

        async record(input: TurnTelemetryInput): Promise<void> {
          await this.withRetry(async () => {
            const doc: TurnTelemetryDoc = { ...input, createdAt: new Date() };
            await this.collection.insertOne(doc);
          }, undefined, `record(${input.agentId})`);
        }

        /**
         * Per-agent cache hit-rate over the trailing `windowMs` (default 7 days).
         *
         * Formula: hitRate = cacheRead / (cacheRead + cacheCreation + input)
         * `inputTokens` here is the *uncached* counter from SDK usage (input_tokens),
         * not a total. The three counters are disjoint, so summing them is the
         * correct "total billable input" denominator.
         *
         * Rows with zero turns OR zero total input return `hitRate: null` so the
         * renderer can show "no data" instead of "0%".
         */
        async hitRatesByAgent(windowMs = 7 * 24 * 60 * 60 * 1000): Promise<CacheHitRateRow[]> {
          return this.withRetry(async () => {
            const since = new Date(Date.now() - windowMs);
            const cursor = this.collection.aggregate<{
              _id: string;
              turns: number;
              inputTokens: number;
              cacheReadTokens: number;
              cacheCreationTokens: number;
              ephemeral5mTokens: number;
              ephemeral1hTokens: number;
            }>([
              { $match: { createdAt: { $gte: since } } },
              {
                $group: {
                  _id: "$agentId",
                  turns: { $sum: 1 },
                  inputTokens: { $sum: "$inputTokens" },
                  cacheReadTokens: { $sum: "$cacheReadTokens" },
                  cacheCreationTokens: { $sum: "$cacheCreationTokens" },
                  ephemeral5mTokens: { $sum: { $ifNull: ["$ephemeral5mTokens", 0] } },
                  ephemeral1hTokens: { $sum: { $ifNull: ["$ephemeral1hTokens", 0] } },
                },
              },
              { $sort: { _id: 1 } },
            ]);
            const rows: CacheHitRateRow[] = [];
            for await (const r of cursor) {
              const denom = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
              rows.push({
                agentId: r._id,
                turns: r.turns,
                inputTokens: r.inputTokens,
                cacheReadTokens: r.cacheReadTokens,
                cacheCreationTokens: r.cacheCreationTokens,
                ephemeral5mTokens: r.ephemeral5mTokens,
                ephemeral1hTokens: r.ephemeral1hTokens,
                hitRate: denom > 0 ? r.cacheReadTokens / denom : null,
              });
            }
            return rows;
          }, [], "hitRatesByAgent");
        }
      }
      ```
- [ ] **Step 2:** Write `src/agents/turn-telemetry.test.ts`. Mock the Mongo collection's `insertOne`, `createIndex`, and `aggregate` (cursor — return an async iterable). Cover: record happy-path, record fail-soft on Mongo throw, aggregator with zero rows, aggregator with one agent / single turn, aggregator with multi-agent two-turn data verifying the formula, aggregator with all-zero counters returning `hitRate: null`, aggregator passes the right `$gte` cutoff.
      ```typescript
      import { describe, it, expect, vi, beforeEach } from "vitest";

      vi.mock("../logging/logger.js", () => ({
        createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
      }));

      import { TurnTelemetryStore } from "./turn-telemetry.js";

      function makeMockDb(rows: any[] = []) {
        const insertOne = vi.fn().mockResolvedValue({ insertedId: "x" });
        const createIndex = vi.fn().mockResolvedValue("ix");
        const aggregate = vi.fn().mockReturnValue({
          [Symbol.asyncIterator]: async function* () { for (const r of rows) yield r; },
        });
        const collection = vi.fn().mockReturnValue({ insertOne, createIndex, aggregate });
        return { db: { collection } as any, mocks: { insertOne, createIndex, aggregate } };
      }

      describe("TurnTelemetryStore", () => {
        let store: TurnTelemetryStore;
        let mocks: ReturnType<typeof makeMockDb>["mocks"];

        beforeEach(async () => {
          const m = makeMockDb();
          store = new TurnTelemetryStore(m.db);
          mocks = m.mocks;
          await store.init();
        });

        it("creates TTL and agent indexes", () => {
          expect(mocks.createIndex).toHaveBeenCalledWith(
            { createdAt: 1 },
            { expireAfterSeconds: 14 * 24 * 60 * 60 },
          );
          expect(mocks.createIndex).toHaveBeenCalledWith({ agentId: 1, createdAt: -1 });
        });

        it("record inserts a doc with createdAt populated", async () => {
          await store.record({
            agentId: "a", threadId: "t", sessionId: "s",
            inputTokens: 100, outputTokens: 50,
            cacheReadTokens: 10, cacheCreationTokens: 5,
          });
          expect(mocks.insertOne).toHaveBeenCalledTimes(1);
          const arg = mocks.insertOne.mock.calls[0][0];
          expect(arg.agentId).toBe("a");
          expect(arg.createdAt).toBeInstanceOf(Date);
        });

        it("record swallows Mongo errors (fail-soft)", async () => {
          mocks.insertOne.mockRejectedValueOnce(new Error("boom"));
          await expect(store.record({
            agentId: "a", threadId: "t", sessionId: "s",
            inputTokens: 0, outputTokens: 0,
            cacheReadTokens: 0, cacheCreationTokens: 0,
          })).resolves.toBeUndefined();
        });
      });

      describe("TurnTelemetryStore.hitRatesByAgent", () => {
        it("returns empty array when no rows match", async () => {
          const m = makeMockDb([]);
          const s = new TurnTelemetryStore(m.db);
          await s.init();
          await expect(s.hitRatesByAgent()).resolves.toEqual([]);
        });

        it("computes hit rate from disjoint input + cache_read + cache_creation totals", async () => {
          // Aggregator $group output (agent-a aggregated).
          const m = makeMockDb([{
            _id: "agent-a", turns: 4,
            inputTokens: 200, cacheReadTokens: 800, cacheCreationTokens: 0,
            ephemeral5mTokens: 0, ephemeral1hTokens: 0,
          }]);
          const s = new TurnTelemetryStore(m.db);
          await s.init();
          const [row] = await s.hitRatesByAgent();
          // 800 / (200 + 800 + 0) = 0.8
          expect(row.hitRate).toBeCloseTo(0.8, 4);
          expect(row.turns).toBe(4);
        });

        it("returns null hitRate when all counters are zero", async () => {
          const m = makeMockDb([{
            _id: "agent-a", turns: 1,
            inputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0,
            ephemeral5mTokens: 0, ephemeral1hTokens: 0,
          }]);
          const s = new TurnTelemetryStore(m.db);
          await s.init();
          const [row] = await s.hitRatesByAgent();
          expect(row.hitRate).toBeNull();
        });

        it("emits one row per agent, sorted by agentId", async () => {
          const m = makeMockDb([
            { _id: "agent-a", turns: 2, inputTokens: 100, cacheReadTokens: 100, cacheCreationTokens: 0, ephemeral5mTokens: 0, ephemeral1hTokens: 0 },
            { _id: "agent-b", turns: 1, inputTokens: 50, cacheReadTokens: 0, cacheCreationTokens: 50, ephemeral5mTokens: 50, ephemeral1hTokens: 0 },
          ]);
          const s = new TurnTelemetryStore(m.db);
          await s.init();
          const rows = await s.hitRatesByAgent();
          expect(rows.map(r => r.agentId)).toEqual(["agent-a", "agent-b"]);
          expect(rows[0].hitRate).toBeCloseTo(0.5, 4);
          expect(rows[1].hitRate).toBeCloseTo(0, 4); // 0 / 100
          expect(rows[1].ephemeral5mTokens).toBe(50);
        });

        it("uses the requested window for the $gte cutoff", async () => {
          const m = makeMockDb([]);
          const s = new TurnTelemetryStore(m.db);
          await s.init();
          const before = Date.now();
          await s.hitRatesByAgent(60_000); // 1 minute
          const after = Date.now();
          const pipeline = m.mocks.aggregate.mock.calls[0][0];
          const since = pipeline[0].$match.createdAt.$gte as Date;
          expect(since.getTime()).toBeGreaterThanOrEqual(before - 60_000);
          expect(since.getTime()).toBeLessThanOrEqual(after - 60_000 + 5);
        });

        it("falls back to [] when the aggregate cursor throws", async () => {
          const m = makeMockDb([]);
          m.mocks.aggregate.mockImplementationOnce(() => {
            throw new Error("network down");
          });
          const s = new TurnTelemetryStore(m.db);
          await s.init();
          await expect(s.hitRatesByAgent()).resolves.toEqual([]);
        });
      });
      ```
- [ ] **Step 3:** Verify — `npm run test -- src/agents/turn-telemetry.test.ts`. Expected: 9 tests pass.
- [ ] **Step 4:** Commit — `git add src/agents/turn-telemetry.ts src/agents/turn-telemetry.test.ts && git commit -m "agents: add TurnTelemetryStore for per-turn cache hit telemetry"`

---

### Task 3: Wire `TurnTelemetryStore` into `AgentManager` and the boot sequence
**Files:**
- Modify `/Users/mokie/github/hive/src/index.ts` (after `sessionStore.init()` at lines 202-203, then thread it into `AgentManager` at line 256).
- Modify `/Users/mokie/github/hive/src/agents/agent-manager.ts` (constructor lines 74-84, post-turn write block lines 294-304).
- Modify `/Users/mokie/github/hive/src/agents/agent-manager.test.ts` (add a test that verifies `TurnTelemetryStore.record` is called per turn with the right shape).

- [ ] **Step 1:** In `src/index.ts`, import the store at the top alongside the other agents/* imports:
      ```typescript
      import { TurnTelemetryStore } from "./agents/turn-telemetry.js";
      ```
      Then directly after the existing block at line 202-203:
      ```typescript
        const sessionStore = new SessionStore(db);
        await sessionStore.init();

        const turnTelemetryStore = new TurnTelemetryStore(db);
        await turnTelemetryStore.init();
      ```
      Pass it into `AgentManager` at line 256:
      ```typescript
      agentManager = new AgentManager(registry, memoryManager, sessionStore, turnTelemetryStore, activityLogger, prefetcher, teamRoster);
      ```
- [ ] **Step 2:** In `src/agents/agent-manager.ts`, import the store and add it as a field:
      ```typescript
      import type { TurnTelemetryStore } from "./turn-telemetry.js";
      ```
      Add the field at line 63 (next to `sessionStore`):
      ```typescript
        private sessionStore: SessionStore;
        private turnTelemetryStore: TurnTelemetryStore;
      ```
      Update the constructor signature (line 74-84). The new arg slots after `sessionStore` (third positional) — keep `activityLogger` etc. as the later positionals so existing test call sites that pass a 3-arg constructor (`new AgentManager(registry, memory, session)`) still type-check after we make the new arg optional with a fail-soft no-op default. But the boot path always provides it; the test path can omit it.
      ```typescript
        constructor(
          registry: AgentRegistry,
          memoryManager: MemoryManager,
          sessionStore: SessionStore,
          turnTelemetryStore?: TurnTelemetryStore,
          activityLogger?: ActivityLogger,
          prefetcher?: CodeIndexPrefetcher,
          teamRoster?: TeamRoster,
        ) {
          this.registry = registry;
          this.memoryManager = memoryManager;
          this.sessionStore = sessionStore;
          // No-op fallback so the rest of the file can call `record` unconditionally.
          // Tests that don't pass a store still exercise the call-shape path without
          // needing a Mongo mock.
          this.turnTelemetryStore = turnTelemetryStore ?? { record: async () => {} } as TurnTelemetryStore;
          this.activityLogger = activityLogger;
          this.prefetcher = prefetcher;
          this.teamRoster = teamRoster;
          // ...rest unchanged
      ```
- [ ] **Step 3:** Add the per-turn telemetry record call in `agent-manager.ts` immediately AFTER the existing `sessionStore.set` block (the block at lines 294-304). It must be parallel and fail-soft. Place it within the same `if (result.sessionId && !result.aborted)` guard so we only record turns that produced a session id (drops aborts and pre-session crashes — same shape as the session write):
      ```typescript
              if (result.sessionId && !result.aborted) {
                this.sessionStore.set(agentId, threadId, result.sessionId, {
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens,
                  cacheReadTokens: result.cacheReadTokens,
                  cacheCreationTokens: result.cacheCreationTokens,
                  contextWindow: result.contextWindow,
                  compactions: result.compactions,
                  preCompactTokens: result.preCompactTokens,
                });
                // Per-turn cache telemetry. Independent of sessionStore.set (which
                // overwrites a per-thread snapshot — no history). The aggregator
                // in `hive doctor` reads this collection.
                this.turnTelemetryStore.record({
                  agentId,
                  threadId,
                  sessionId: result.sessionId,
                  model: modelOverride ?? this.registry.get(agentId)?.model,
                  inputTokens: result.inputTokens,
                  outputTokens: result.outputTokens,
                  cacheReadTokens: result.cacheReadTokens,
                  cacheCreationTokens: result.cacheCreationTokens,
                  ephemeral5mTokens: result.ephemeral5mTokens,
                  ephemeral1hTokens: result.ephemeral1hTokens,
                }).catch(() => {
                  // Already logged inside the store via withRetry. Swallow here so a
                  // telemetry write failure cannot cascade into the turn pipeline.
                });
              }
      ```
- [ ] **Step 4:** In `agent-manager.test.ts`, add a `makeMockTurnTelemetryStore` helper near `makeMockSessionStore` (~line 140) and a test inside `describe("sendMessage", ...)`:
      ```typescript
      function makeMockTurnTelemetryStore() {
        return {
          record: vi.fn().mockResolvedValue(undefined),
        };
      }
      ```
      In the top-level `beforeEach`, instantiate it and pass into the constructor:
      ```typescript
        let turnTelemetryStore: ReturnType<typeof makeMockTurnTelemetryStore>;
        // ...
        beforeEach(() => {
          // ...existing setup
          turnTelemetryStore = makeMockTurnTelemetryStore();
          manager = new AgentManager(
            registry as any,
            memoryManager as any,
            sessionStore as any,
            turnTelemetryStore as any,
          );
        });
      ```
      Add the test:
      ```typescript
          it("records per-turn cache telemetry after a successful turn", async () => {
            const item = makeWorkItem();
            await manager.sendMessage("agent-a", item);
            expect(turnTelemetryStore.record).toHaveBeenCalledTimes(1);
            const arg = turnTelemetryStore.record.mock.calls[0][0];
            expect(arg.agentId).toBe("agent-a");
            expect(arg.cacheReadTokens).toBe(10);
            expect(arg.cacheCreationTokens).toBe(5);
            expect(arg.inputTokens).toBe(100);
          });

          it("does not record telemetry when the turn was aborted", async () => {
            mockRunnerSend.mockResolvedValueOnce(makeRunResult({ aborted: true }));
            const item = makeWorkItem();
            await manager.sendMessage("agent-a", item);
            expect(turnTelemetryStore.record).not.toHaveBeenCalled();
          });
      ```
- [ ] **Step 5:** Verify — run the affected tests:
      `npm run test -- src/agents/agent-manager.test.ts`
      Expected: existing tests still pass (the optional-arg signature is backwards-compatible) plus the two new ones.
- [ ] **Step 6:** Commit — `git add src/index.ts src/agents/agent-manager.ts src/agents/agent-manager.test.ts && git commit -m "agent-manager: record per-turn cache telemetry alongside session snapshot"`

---

### Task 4: Add `promptCacheCheck` doctor helper and render the new section
**Files:**
- Modify `/Users/mokie/github/hive/src/cli/doctor-checks.ts` (add a `cacheHitRatesForDoctor` async helper near other live-check helpers ~line 105).
- Modify `/Users/mokie/github/hive/src/cli/doctor.ts` (add a "Prompt cache" rendering block after the existing groups loop, just before the `if (!allPassed)` check at line 274).
- Modify `/Users/mokie/github/hive/src/cli/doctor-checks.test.ts` (add tests for the helper).
- Modify `/Users/mokie/github/hive/src/cli/doctor.test.ts` (add a rendering test).

- [ ] **Step 1:** In `doctor-checks.ts`, add a helper that wraps `TurnTelemetryStore` for the doctor's read-only use. It uses its own `MongoClient` (matching the existing `mongoReachable`/`hasAnyAgent`/`defaultAgentExists` pattern at lines 105-146 — they each open a short-lived client because the doctor command is a one-shot CLI, not the running engine):
      ```typescript
      // ── prompt cache observability (KPR-140) ───────────────────────────────

      export interface PromptCacheRow {
        agentId: string;
        turns: number;
        cacheReadTokens: number;
        cacheCreationTokens: number;
        inputTokens: number;
        ephemeral5mTokens: number;
        ephemeral1hTokens: number;
        hitRate: number | null;
      }

      /**
       * Read-only doctor adapter for the agent_turn_telemetry collection. Uses a
       * short-lived MongoClient like the other live checks in this file —
       * `hive doctor` is a one-shot CLI, not the running engine.
       */
      export async function cacheHitRatesForDoctor(
        uri: string,
        dbName: string,
        windowMs = 7 * 24 * 60 * 60 * 1000,
      ): Promise<PromptCacheRow[]> {
        const { MongoClient } = await import("mongodb");
        const client = new MongoClient(uri, { serverSelectionTimeoutMS: 2000 });
        try {
          await client.connect();
          const since = new Date(Date.now() - windowMs);
          const cursor = client
            .db(dbName)
            .collection("agent_turn_telemetry")
            .aggregate<{
              _id: string;
              turns: number;
              inputTokens: number;
              cacheReadTokens: number;
              cacheCreationTokens: number;
              ephemeral5mTokens: number;
              ephemeral1hTokens: number;
            }>([
              { $match: { createdAt: { $gte: since } } },
              {
                $group: {
                  _id: "$agentId",
                  turns: { $sum: 1 },
                  inputTokens: { $sum: "$inputTokens" },
                  cacheReadTokens: { $sum: "$cacheReadTokens" },
                  cacheCreationTokens: { $sum: "$cacheCreationTokens" },
                  ephemeral5mTokens: { $sum: { $ifNull: ["$ephemeral5mTokens", 0] } },
                  ephemeral1hTokens: { $sum: { $ifNull: ["$ephemeral1hTokens", 0] } },
                },
              },
              { $sort: { _id: 1 } },
            ]);
          const rows: PromptCacheRow[] = [];
          for await (const r of cursor) {
            const denom = r.inputTokens + r.cacheReadTokens + r.cacheCreationTokens;
            rows.push({
              agentId: r._id,
              turns: r.turns,
              cacheReadTokens: r.cacheReadTokens,
              cacheCreationTokens: r.cacheCreationTokens,
              inputTokens: r.inputTokens,
              ephemeral5mTokens: r.ephemeral5mTokens,
              ephemeral1hTokens: r.ephemeral1hTokens,
              hitRate: denom > 0 ? r.cacheReadTokens / denom : null,
            });
          }
          return rows;
        } catch {
          return [];
        } finally {
          await client.close().catch(() => {});
        }
      }

      /** Format a hit-rate value for display. Mirrors the "no data" branch in the aggregator. */
      export function formatHitRate(rate: number | null): string {
        if (rate === null) return "no data";
        return `${(rate * 100).toFixed(1)}%`;
      }
      ```
      Note: the helper deliberately mirrors the aggregator pipeline rather than re-using `TurnTelemetryStore` because the doctor opens its own client and the runtime store holds its `Db` ref. Keeping the duplication local to one file keeps the layering clean (`doctor-checks.ts` already does this for the other Mongo helpers).
- [ ] **Step 2:** In `doctor.ts`, import the new helpers at the top:
      ```typescript
      import {
        type Check,
        type CheckGroup,
        // ...existing imports...
        cacheHitRatesForDoctor,
        formatHitRate,
      } from "./doctor-checks.js";
      ```
      Add a small exported helper at module scope (after `resolveRequiredEnvVars`, before `runDoctor`) so the rendering is unit-testable in isolation without spinning up `runDoctor`'s full check pipeline:
      ```typescript
      /**
       * Render the "Prompt cache" doctor section. Exported so the unit test
       * doesn't need to invoke `runDoctor` (which runs every other doctor
       * check and may exit non-zero on a CI environment without brew/Node22).
       * Informational — does not affect exit code.
       */
      export function renderPromptCacheSection(rows: PromptCacheRow[], emit: (line: string) => void = console.log): void {
        emit("\nPrompt cache (last 7 days)");
        if (rows.length === 0) {
          emit("  ○ no telemetry yet — let the hive run for a window and re-check");
          return;
        }
        for (const r of rows) {
          const ephemeralBreakdown =
            r.ephemeral5mTokens > 0 || r.ephemeral1hTokens > 0
              ? ` (5m=${r.ephemeral5mTokens}, 1h=${r.ephemeral1hTokens})`
              : "";
          emit(
            `  ${r.agentId}: hit=${formatHitRate(r.hitRate)} read=${r.cacheReadTokens} create=${r.cacheCreationTokens}${ephemeralBreakdown} input=${r.inputTokens} turns=${r.turns}`,
          );
        }
      }
      ```
      Then update the import to bring in `PromptCacheRow` from `doctor-checks.js` (the type is already declared there in Task 4 Step 1):
      ```typescript
      import {
        type Check,
        type CheckGroup,
        type PromptCacheRow,
        // ...existing imports...
        cacheHitRatesForDoctor,
        formatHitRate,
      } from "./doctor-checks.js";
      ```
      And, after the existing `for (const check of checks)` loop ends and immediately before the `if (!allPassed)` block at line 274, call the renderer:
      ```typescript
        // Prompt cache observability (KPR-140). Informational — does not
        // contribute to allPassed; missing telemetry never fails the doctor.
        if (config) {
          const rows = await cacheHitRatesForDoctor(config.mongo.uri, config.mongo.dbName);
          renderPromptCacheSection(rows);
        } else {
          console.log("\nPrompt cache (last 7 days)");
          console.log("  ○ skipped: config not loaded");
        }
      ```
- [ ] **Step 3:** In `doctor-checks.test.ts`, extend the existing `mongodb` mock factory (line 132-143) with an `aggregate` returning an async iterable, then add a describe block for the new helper. Place the new tests AFTER the existing `defaultAgentExists` describe so the existing mock state stays intact:
      ```typescript
      // Patch the existing mongo mock to also expose aggregate. Add this inside
      // the existing vi.mock("mongodb", ...) factory return:
      //   const aggregate = vi.fn();
      //   collection now returns { estimatedDocumentCount, findOne, aggregate }
      //   __mocks now also exposes aggregate
      ```
      Concrete test additions (inside the existing test file, after the `slackAuthOk` describe):
      ```typescript
      import { cacheHitRatesForDoctor, formatHitRate } from "./doctor-checks.js";

      describe("formatHitRate", () => {
        it("renders null as 'no data'", () => {
          expect(formatHitRate(null)).toBe("no data");
        });
        it("renders a fraction as a percentage with one decimal", () => {
          expect(formatHitRate(0.8123)).toBe("81.2%");
          expect(formatHitRate(0)).toBe("0.0%");
        });
      });

      describe("cacheHitRatesForDoctor", () => {
        beforeEach(() => {
          mongoMocks.connect.mockReset().mockResolvedValue(undefined);
          mongoMocks.close.mockReset().mockResolvedValue(undefined);
          mongoMocks.aggregate.mockReset();
        });

        it("returns [] when the collection has no rows", async () => {
          mongoMocks.aggregate.mockReturnValue({
            [Symbol.asyncIterator]: async function* () {},
          });
          await expect(cacheHitRatesForDoctor("mongodb://x", "hive_test")).resolves.toEqual([]);
        });

        it("computes hit rate from disjoint counters", async () => {
          mongoMocks.aggregate.mockReturnValue({
            [Symbol.asyncIterator]: async function* () {
              yield {
                _id: "agent-a", turns: 3,
                inputTokens: 100, cacheReadTokens: 400, cacheCreationTokens: 0,
                ephemeral5mTokens: 0, ephemeral1hTokens: 0,
              };
            },
          });
          const rows = await cacheHitRatesForDoctor("mongodb://x", "hive_test");
          expect(rows).toHaveLength(1);
          expect(rows[0].hitRate).toBeCloseTo(0.8, 4);
          expect(rows[0].turns).toBe(3);
        });

        it("returns [] when the connection throws", async () => {
          mongoMocks.connect.mockRejectedValueOnce(new Error("ECONNREFUSED"));
          await expect(cacheHitRatesForDoctor("mongodb://x", "hive_test")).resolves.toEqual([]);
        });
      });
      ```
      And update the existing `vi.mock("mongodb", ...)` factory (lines 132-143) to expose `aggregate`:
      ```typescript
      vi.mock("mongodb", () => {
        const ping = vi.fn();
        const estimatedDocumentCount = vi.fn();
        const findOne = vi.fn();
        const aggregate = vi.fn();
        const collection = vi.fn(() => ({ estimatedDocumentCount, findOne, aggregate }));
        const command = vi.fn((cmd: unknown) => ping(cmd));
        const db = vi.fn(() => ({ command, collection }));
        const connect = vi.fn();
        const close = vi.fn();
        const MongoClient = vi.fn(() => ({ connect, db, close }));
        return { MongoClient, __mocks: { connect, close, ping, estimatedDocumentCount, findOne, aggregate } };
      });
      ```
- [ ] **Step 4:** In `doctor.test.ts`, add a top-level describe block testing `renderPromptCacheSection` directly. Capturing emitted lines via the injected `emit` callback avoids monkey-patching `console.log` and keeps the test isolated from the rest of `runDoctor`:
      ```typescript
      // Add this import next to the existing one:
      import { renderPromptCacheSection } from "./doctor.js";

      describe("renderPromptCacheSection", () => {
        it("renders 'no telemetry yet' when the rows are empty", () => {
          const lines: string[] = [];
          renderPromptCacheSection([], (l) => lines.push(l));
          expect(lines.join("\n")).toContain("Prompt cache (last 7 days)");
          expect(lines.join("\n")).toContain("no telemetry yet");
        });

        it("renders one row per agent with hit rate, read, create, input, turns", () => {
          const lines: string[] = [];
          renderPromptCacheSection([
            { agentId: "chief-of-staff", turns: 12, cacheReadTokens: 8000,
              cacheCreationTokens: 1000, inputTokens: 1000,
              ephemeral5mTokens: 800, ephemeral1hTokens: 200, hitRate: 0.8 },
          ], (l) => lines.push(l));
          expect(lines.join("\n")).toMatch(
            /chief-of-staff: hit=80\.0% read=8000 create=1000 \(5m=800, 1h=200\) input=1000 turns=12/,
          );
        });

        it("omits the ephemeral breakdown when both counters are zero", () => {
          const lines: string[] = [];
          renderPromptCacheSection([
            { agentId: "rae", turns: 1, cacheReadTokens: 50,
              cacheCreationTokens: 50, inputTokens: 100,
              ephemeral5mTokens: 0, ephemeral1hTokens: 0, hitRate: 0.25 },
          ], (l) => lines.push(l));
          expect(lines.join("\n")).not.toContain("(5m=");
          expect(lines.join("\n")).toContain("hit=25.0%");
        });

        it("renders 'no data' for a row with null hitRate", () => {
          const lines: string[] = [];
          renderPromptCacheSection([
            { agentId: "ghost", turns: 1, cacheReadTokens: 0,
              cacheCreationTokens: 0, inputTokens: 0,
              ephemeral5mTokens: 0, ephemeral1hTokens: 0, hitRate: null },
          ], (l) => lines.push(l));
          expect(lines.join("\n")).toContain("hit=no data");
        });
      });
      ```
- [ ] **Step 5:** Verify — run the doctor tests and the new check tests:
      `npm run test -- src/cli/doctor-checks.test.ts src/cli/doctor.test.ts`
      Expected: all existing tests still pass plus the new ones for `formatHitRate`, `cacheHitRatesForDoctor`, and the rendering block.
- [ ] **Step 6:** Commit — `git add src/cli/doctor-checks.ts src/cli/doctor.ts src/cli/doctor-checks.test.ts src/cli/doctor.test.ts && git commit -m "doctor: add Prompt cache section over agent_turn_telemetry"`

---

### Task 5: Final gate — `npm run check`
**Files:** None (verification only).

- [ ] **Step 1:** Run the full check gate: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`. (Env stubs per `reference_npm_check_env_stubs.md` — required by config loader at module eval time even though tests mock things.)
- [ ] **Step 2:** Expected output: `typecheck` passes, `lint` passes, `format` passes (run `npm run format` to auto-fix if Prettier flags drift), `test` passes with the new test files included.
- [ ] **Step 3:** No commit — this task is purely a gate.

---

## Spec Ambiguities

None. The spec explicitly:
- Locks the collection name as `agent_turn_telemetry` and TTL at 14 days.
- Locks the formula and the no-data / zero-input handling.
- Locks the window at 7 days, with no CLI flag in v1.
- Permits omitting ephemeral fields if the SDK doesn't surface them and asks for a code comment marking the gap (Task 1 Step 3 includes that comment).
- Lists everything else (Path B, restructured systemPrompt, upstream SDK feature request, CLI window flag) as out-of-scope.

The only judgement call this plan made is the doctor's mongo helper duplicating the aggregation pipeline rather than re-using `TurnTelemetryStore` — done because `doctor-checks.ts` already follows the "open a short-lived MongoClient per check" pattern (`mongoReachable`, `hasAnyAgent`, `defaultAgentExists`). Routing the doctor through the runtime store would force passing a `Db` ref into a CLI helper, breaking that layering. This matches existing conventions; calling it out here for traceability.
