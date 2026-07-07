import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Collection } from "mongodb";
import type { AgentDefinition } from "../types/agent-definition.js";

/**
 * KPR-295 Task 3 — integration assembly test.
 *
 * Wires the REAL `AgentRegistry` (guard logic from Task 1, commit `eaa99fc`)
 * + REAL `buildRosterStatsDoc` over a switchable fake Mongo collection, with
 * a harness that MIRRORS `index.ts`'s reload wiring (Task 2, commit
 * `1e2c259`) in miniature. `index.ts`'s `reload()`/`safeReload` machinery
 * lives inside the `main()` closure and is not directly importable, so this
 * harness reproduces its shape rather than calling it — see the DRIFT GUARD
 * note below for how to keep the two in sync.
 *
 * Mirrored anchors in `src/index.ts` (cite exact names/lines; re-check this
 * comment whenever `index.ts`'s reload machinery changes):
 *   - `writeRosterStats` (index.ts:181-191) — upserts `buildRosterStatsDoc(
 *     registry.getRosterGuardState())` onto `{ kind: "agent_roster_stats" }`
 *     via the raw (guard-immune) telemetry collection, on every reload outcome.
 *   - `reload` closure (index.ts:193-225) — calls `registry.load()`, then
 *     ALWAYS calls `writeRosterStats()` (line 199, "every outcome, incl.
 *     blocked"), then short-circuits on `result.blocked` (line 200) BEFORE
 *     `stopAgent`/`scheduler.reloadSchedules`/`agentManager.reloadSkills`/
 *     `agentManager.rescanPlugins`.
 *   - `safeReload` (index.ts:230-232) — `reload().catch(err => log.error(...))`;
 *     the catch must never itself throw (fire-and-forget call sites can't
 *     produce an unhandled rejection).
 *   - debounce site — `registry = new AgentRegistry(agentDefsCollection, () => {
 *     if (reloadTimer) clearTimeout(reloadTimer); reloadTimer = setTimeout(
 *     safeReload, 500); })` (index.ts:234-237): the `onChangeDetected`
 *     callback passed to the AgentRegistry constructor IS the 500ms debounce
 *     -> safeReload wiring. The same debounce-then-safeReload shape is
 *     repeated at the skills-watcher (index.ts:448-449), agent-private-skills
 *     watcher (index.ts:470-471), and SIGUSR1 handler (index.ts:484, which
 *     calls `safeReload()` directly, no debounce).
 *   - degraded-retry tick — `AgentRegistry.blockEmptyReload()` (agent-
 *     registry.ts) starts a `setInterval(() => this.onChangeDetected?.(),
 *     POLL_INTERVAL_MS)` (POLL_INTERVAL_MS = 30_000) while degraded, i.e. it re-invokes the
 *     SAME `onChangeDetected` callback the constructor was given — so in the
 *     real engine, each retry tick also flows through the 500ms debounce ->
 *     safeReload path above.
 *
 * Posture matches `src/db/db-identity.integration.test.ts` (KPR-294): fake
 * driver (mutable-docs collection + telemetry stub recording `updateOne`
 * calls), real modules (`AgentRegistry`, `buildRosterStatsDoc`), no real
 * mongod. Fake timers + `vi.advanceTimersByTimeAsync` throughout — the
 * debounce and the 30s retry both hop timers around awaits.
 */

// AgentRegistry transitively imports config.ts, which requires these env vars
// at module load. Same stub list as agent-registry.test.ts.
process.env.SLACK_APP_TOKEN ??= "xapp-test";
process.env.SLACK_BOT_TOKEN ??= "xoxb-test";
process.env.MONGODB_URI ??= "mongodb://localhost:27017";
process.env.OPENPHONE_API_KEY ??= "test";

// agent-registry.ts calls createLogger("agent-registry") once at module load
// — the mock must return the SAME object every call so tests can assert
// against it (vi.hoisted required: vi.mock factories are hoisted above
// top-level const declarations). Same pattern as db-identity.integration.test.ts.
const mockLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../logging/logger.js", () => ({
  createLogger: () => mockLog,
}));

type AgentRegistryModule = typeof import("./agent-registry.js");
let AgentRegistry: AgentRegistryModule["AgentRegistry"];
let buildRosterStatsDoc: AgentRegistryModule["buildRosterStatsDoc"];

const DEBOUNCE_MS = 500;
const RETRY_MS = 30_000;

function makeDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    _id: "test-agent",
    name: "TestAgent",
    model: "claude-haiku-4-5",
    icon: "",
    channels: ["agent-test"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    coreServers: [],
    delegateServers: [],
    delegatePrompts: {},
    soul: "",
    systemPrompt: "",
    schedule: [],
    budgetUsd: 10,
    maxTurns: 200,
    maxConcurrent: 3,
    timeoutMs: 300_000,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: "test",
    ...overrides,
  };
}

/** Mutable-docs fake agent_definitions collection. `find()` can be forced to
 * reject once via `rejectNextFind`, mirroring db-identity's mockRejectedValueOnce
 * style for the "hot-reload failure" edge case. */
function makeFakeAgentDefsCollection(initialDocs: AgentDefinition[]): {
  collection: Collection<AgentDefinition>;
  setDocs: (docs: AgentDefinition[]) => void;
  rejectNextFind: (err: Error) => void;
} {
  let docs = initialDocs;
  let pendingRejection: Error | null = null;
  const collection = {
    find: () => ({
      toArray: async () => {
        if (pendingRejection) {
          const err = pendingRejection;
          pendingRejection = null;
          throw err;
        }
        return docs;
      },
    }),
  } as unknown as Collection<AgentDefinition>;
  return {
    collection,
    setDocs: (next) => (docs = next),
    rejectNextFind: (err) => (pendingRejection = err),
  };
}

/** Fake telemetry collection — records every `updateOne(filter, update, opts)`
 * call. `rejectNextUpdate` forces the next call to reject, for the
 * stats-write-fail-open edge case. */
function makeFakeTelemetryCollection(): {
  updateOne: ReturnType<typeof vi.fn>;
  rejectNextUpdate: (err: Error) => void;
} {
  let pendingRejection: Error | null = null;
  const updateOne = vi.fn(async (..._args: unknown[]) => {
    if (pendingRejection) {
      const err = pendingRejection;
      pendingRejection = null;
      throw err;
    }
    return { acknowledged: true };
  });
  return { updateOne, rejectNextUpdate: (err) => (pendingRejection = err) };
}

/**
 * Harness mirroring `index.ts`'s reload machinery in miniature (see header
 * comment for exact anchors). Constructs a REAL `AgentRegistry` whose
 * `onChangeDetected` callback is the 500ms-debounce -> `safeReload` wiring
 * from index.ts:234-237. `writeRosterStats` and `reload`/`safeReload` are
 * reproduced verbatim (modulo the `agentManager`/`scheduler` presence guard,
 * which is irrelevant here since this harness has no boot-ordering race to
 * protect against).
 */
function buildHarness(initialDocs: AgentDefinition[]) {
  const { collection, setDocs, rejectNextFind } = makeFakeAgentDefsCollection(initialDocs);
  const telemetry = makeFakeTelemetryCollection();

  const stopAgent = vi.fn();
  const reloadSchedules = vi.fn(async () => {});
  const reloadSkills = vi.fn();
  const rescanPlugins = vi.fn();

  // eslint-disable-next-line prefer-const
  let registry: InstanceType<AgentRegistryModule["AgentRegistry"]>;
  let reloadTimer: ReturnType<typeof setTimeout> | null = null;

  // Mirrors index.ts:181-191 (writeRosterStats).
  const writeRosterStats = async () => {
    try {
      await telemetry.updateOne(
        { kind: "agent_roster_stats" },
        { $set: { ...buildRosterStatsDoc(registry.getRosterGuardState()), updatedAt: new Date() } },
        { upsert: true },
      );
    } catch (err) {
      mockLog.warn("roster stats write failed", { error: String(err) });
    }
  };

  // Mirrors index.ts:193-225 (reload), minus the agentManager/scheduler
  // presence guard (index.ts:195) — not applicable to this harness.
  const reload = async () => {
    const result = await registry.load();
    await writeRosterStats(); // every outcome, incl. blocked
    if (result.blocked) return; // roster kept; skip stops/schedules/skills/plugins

    if (result.removed.length) {
      for (const id of result.removed) {
        stopAgent(id);
      }
    }
    const disabled = registry.getDisabled();
    for (const agent of disabled) {
      stopAgent(agent.id);
    }

    await reloadSchedules();
    reloadSkills();
    rescanPlugins();
  };

  // Mirrors index.ts:230-232 (safeReload) — the .catch must never itself throw.
  const safeReload = () => {
    reload().catch((err) => mockLog.error("hot-reload failed — roster unchanged", { error: String(err) }));
  };

  // Mirrors index.ts:234-237 — onChangeDetected IS the 500ms debounce -> safeReload wiring.
  registry = new AgentRegistry(collection, () => {
    if (reloadTimer) clearTimeout(reloadTimer);
    reloadTimer = setTimeout(safeReload, DEBOUNCE_MS);
  });

  return {
    registry,
    setDocs,
    rejectNextFind,
    telemetry,
    stopAgent,
    reloadSchedules,
    reloadSkills,
    rescanPlugins,
    safeReload,
    writeRosterStats,
    /** Fires the harness's onChangeDetected path (i.e. simulates a change-stream/poll trigger). */
    fireChangeDetected: () => {
      if (reloadTimer) clearTimeout(reloadTimer);
      reloadTimer = setTimeout(safeReload, DEBOUNCE_MS);
    },
  };
}

async function flush(times = 15): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

function lastTelemetrySet(telemetry: ReturnType<typeof makeFakeTelemetryCollection>): Record<string, unknown> {
  const call = telemetry.updateOne.mock.calls.at(-1);
  if (!call) throw new Error("updateOne was never called");
  return (call[1] as { $set: Record<string, unknown> }).$set;
}

describe("roster-guard integration (real AgentRegistry + buildRosterStatsDoc, mirrored index.ts reload harness)", () => {
  beforeEach(async () => {
    vi.useFakeTimers();
    mockLog.debug.mockClear();
    mockLog.info.mockClear();
    mockLog.warn.mockClear();
    mockLog.error.mockClear();

    const registryModule = await import("./agent-registry.js");
    AgentRegistry = registryModule.AgentRegistry;
    buildRosterStatsDoc = registryModule.buildRosterStatsDoc;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // --- Scenario 1: the incident, end-to-end ---
  it("incident end-to-end: 3-agent roster -> empty read -> reload blocked, roster served unchanged, degraded telemetry", async () => {
    const initialDocs = [
      makeDefinition({ _id: "agent-a" }),
      makeDefinition({ _id: "agent-b" }),
      makeDefinition({ _id: "agent-c" }),
    ];
    const h = buildHarness(initialDocs);

    // Commit the 3-agent roster (boot-shaped initial load), same as index.ts:238.
    await h.registry.load();
    await h.writeRosterStats();
    expect(h.registry.getAll().map((a) => a.id).sort()).toEqual(["agent-a", "agent-b", "agent-c"]);

    const beforeGet = h.registry.get("agent-a");
    const beforeAll = h.registry.getAll();

    // Incident: the DB read comes back empty (impostor/wiped DB signature).
    h.setDocs([]);
    h.fireChangeDetected();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await flush();

    // Registry still serves all 3 agents — untouched.
    expect(h.registry.get("agent-a")).toEqual(beforeGet);
    expect(h.registry.getAll()).toEqual(beforeAll);
    expect(h.registry.getAll()).toHaveLength(3);

    // None of the destructive reload side effects ran.
    expect(h.stopAgent).not.toHaveBeenCalled();
    expect(h.reloadSchedules).not.toHaveBeenCalled();
    expect(h.reloadSkills).not.toHaveBeenCalled();
    expect(h.rescanPlugins).not.toHaveBeenCalled();

    // Telemetry recorded the blocked/degraded outcome with last-good values.
    const set = lastTelemetrySet(h.telemetry);
    expect(set.degraded).toBe(true);
    expect(set.docCount).toBe(3);
    expect(set.lastGoodAt).not.toBeNull();
  });

  // --- Scenario 2: auto-recovery ---
  it("auto-recovery: restoring docs + 30s retry tick applies the commit, clears degraded, stops the retry timer", async () => {
    const initialDocs = [
      makeDefinition({ _id: "agent-a" }),
      makeDefinition({ _id: "agent-b" }),
      makeDefinition({ _id: "agent-c" }),
    ];
    const h = buildHarness(initialDocs);
    await h.registry.load();
    await h.writeRosterStats();

    // Drive into the incident (same as scenario 1).
    h.setDocs([]);
    h.fireChangeDetected();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await flush();
    expect(h.registry.getRosterGuardState().degraded).toBe(true);

    // Recovery: DB comes back non-empty. The degraded-retry `setInterval`
    // inside AgentRegistry.blockEmptyReload() fires onChangeDetected again at
    // the 30s mark -> debounce -> safeReload -> registry.load() succeeds.
    const newRoster = [makeDefinition({ _id: "agent-x" }), makeDefinition({ _id: "agent-y" })];
    h.setDocs(newRoster);
    const telemetryCallsBeforeRetry = h.telemetry.updateOne.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RETRY_MS + DEBOUNCE_MS);
    await flush();

    // New roster committed and visible.
    expect(h.registry.get("agent-x")).toBeDefined();
    expect(h.registry.get("agent-y")).toBeDefined();
    expect(h.registry.get("agent-a")).toBeUndefined();
    expect(h.registry.getAll().map((a) => a.id).sort()).toEqual(["agent-x", "agent-y"]);

    const state = h.registry.getRosterGuardState();
    expect(state.degraded).toBe(false);
    expect(state.lastRecoveryAt).not.toBeNull();

    const set = lastTelemetrySet(h.telemetry);
    expect(set.degraded).toBe(false);
    expect(h.telemetry.updateOne.mock.calls.length).toBeGreaterThan(telemetryCallsBeforeRetry);

    // Retry timer must be stopped post-recovery: advancing another
    // 30s+500ms must not trigger any further reload (no additional
    // telemetry write, no additional onChangeDetected-driven state churn).
    const callsAfterRecovery = h.telemetry.updateOne.mock.calls.length;
    const stopAgentCallsAfterRecovery = h.stopAgent.mock.calls.length;
    await vi.advanceTimersByTimeAsync(RETRY_MS + DEBOUNCE_MS);
    await flush();
    expect(h.telemetry.updateOne.mock.calls.length).toBe(callsAfterRecovery);
    expect(h.stopAgent.mock.calls.length).toBe(stopAgentCallsAfterRecovery);
  });

  // --- Scenario 3: safeReload swallows rejection (edge case) ---
  it("safeReload swallows a load() rejection: no unhandled rejection escapes, roster untouched, degraded stays false, log.error fired", async () => {
    const initialDocs = [makeDefinition({ _id: "agent-a" }), makeDefinition({ _id: "agent-b" })];
    const h = buildHarness(initialDocs);
    await h.registry.load();
    await h.writeRosterStats();

    const beforeAll = h.registry.getAll();

    // Force the underlying find() to reject once — a genuine load failure,
    // NOT an empty-successful-read. This must not be treated as a guard event.
    h.rejectNextFind(new Error("connection reset"));

    // Calling safeReload() directly must not produce an unhandled rejection
    // (vitest fails the run on unhandled rejections by default) — this
    // assertion is implicit in the test completing at all, but we also
    // assert the resulting state explicitly.
    h.safeReload();
    await flush();

    expect(h.registry.getAll()).toEqual(beforeAll);
    expect(h.registry.getRosterGuardState().degraded).toBe(false);

    // The reload()'s own .catch logs "hot-reload failed" (index.ts:231) —
    // this is a hot-reload failure log, distinct from the roster-guard's own
    // "EMPTY ROSTER READ" critical log (which must NOT have fired here).
    expect(mockLog.error).toHaveBeenCalledWith("hot-reload failed — roster unchanged", expect.anything());
    const emptyRosterCalls = mockLog.error.mock.calls.filter((c) => c[0] === "EMPTY ROSTER READ — keeping last-good roster");
    expect(emptyRosterCalls).toHaveLength(0);
  });

  // --- Scenario 4: stats write fail-open (edge case) ---
  it("stats write fail-open: telemetry updateOne rejects during a blocked reload; reload still completes, roster kept, warn logged, no throw escapes", async () => {
    const initialDocs = [makeDefinition({ _id: "agent-a" }), makeDefinition({ _id: "agent-b" })];
    const h = buildHarness(initialDocs);
    await h.registry.load();
    await h.writeRosterStats();

    const beforeAll = h.registry.getAll();

    // Blocked reload: empty read.
    h.setDocs([]);
    // Telemetry write fails for this reload's writeRosterStats() call.
    h.telemetry.rejectNextUpdate(new Error("telemetry unavailable"));

    h.fireChangeDetected();
    await vi.advanceTimersByTimeAsync(DEBOUNCE_MS);
    await flush();

    // The blocked reload still completed correctly despite the telemetry failure.
    expect(h.registry.getAll()).toEqual(beforeAll);
    expect(h.registry.getRosterGuardState().degraded).toBe(true);
    expect(h.stopAgent).not.toHaveBeenCalled();

    // A warn was logged for the stats-write failure (writeRosterStats' own catch).
    expect(mockLog.warn).toHaveBeenCalledWith("roster stats write failed", expect.anything());

    // No throw escaped the flow — safeReload's error path was not invoked
    // for this cause (the failure was contained inside writeRosterStats'
    // own try/catch, per index.ts:181-191).
    expect(mockLog.error).not.toHaveBeenCalledWith("hot-reload failed — roster unchanged", expect.anything());
  });
});
