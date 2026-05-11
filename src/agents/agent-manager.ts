import { createLogger } from "../logging/logger.js";
import type { AgentState, AgentStatus } from "../types/agent-config.js";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import { AgentRunner, DIST_DIR, type RunResult, type StreamCallback, type WorkItemContext } from "./agent-runner.js";
import { AgentRegistry } from "./agent-registry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SessionStore } from "./session-store.js";
import type { TurnTelemetryStore } from "./turn-telemetry.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import type { Db } from "mongodb";
import { formatFilesForPrompt } from "../files/file-processor.js";
import { routeModel, type ResourceLimits } from "./model-router.js";
import { config as appConfig } from "../config.js";
import { loadPlugins, rescanPluginBrokenServers } from "../plugins/plugin-loader.js";
import type { LoadedPlugin } from "../plugins/types.js";
import { loadSkillIndex, type SkillIndex } from "./skill-loader.js";
import { skillsDir, seedsDir, hiveHome } from "../paths.js";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { ConversationIndex } from "../search/conversation-index.js";
import type { ActivityLogger } from "../activity/activity-logger.js";
import type { CodeIndexPrefetcher } from "../code-index/prefetcher.js";
import type { TeamRoster } from "../team-roster/team-roster.js";
import type { PrefixCache } from "./prefix-cache.js";

const log = createLogger("agent-manager");
const conversationIndex = new ConversationIndex();

/**
 * Discover seed directories that contain skills.
 * Returns absolute paths to seed dirs (e.g., ["<repo>/seeds/chief-of-staff"]).
 */
function discoverSeedDirs(rootSeedsDir: string): string[] {
  if (!existsSync(rootSeedsDir)) return [];
  try {
    return readdirSync(rootSeedsDir)
      .map((d) => join(rootSeedsDir, d))
      .filter((p) => {
        try {
          return statSync(p).isDirectory() && existsSync(join(p, "skills"));
        } catch {
          return false;
        }
      });
  } catch {
    return [];
  }
}

/**
 * KPR-216 + KPR-220: per-turn spawn API. AgentManager.spawnTurn is the only
 * execution path post-KPR-220. Each call spawns a fresh `query()` with
 * `options.resume = ctx.sessionId`; in-process MCP servers are built fresh
 * too so channel/thread context is captured at spawn time (no mutable
 * contextRef across turns).
 *
 * Per-thread serialization (lock key `agentId:threadId`) is enforced by
 * `withSpawnTicket` (Phase 2). Per-agent budget by `spawnBudgetFor`.
 */
export interface TurnContext {
  agentId: string;
  /** undefined on first turn; SDK may rotate post-compaction (KPR-211). */
  sessionId: string | undefined;
  channelId: string;
  threadId: string;
  workItem: WorkItem;
  channel: ChannelKind;
  /**
   * KPR-219: bypass `AgentRunner.buildSystemPrompt` entirely when set. Voice
   * uses this to inject `buildVoiceSystemPrompt` output (omits tool summaries,
   * adds call goal/context). Other channels leave it undefined and get the
   * standard prefix builder. Forward-compatible — any future channel-specific
   * prompt builder plugs in here without touching AgentRunner.
   */
  systemPromptOverride?: string;
  /**
   * KPR-220 Phase 6: marks reflection turns so they don't recursively
   * reschedule reflection. Other channel turns leave this undefined.
   */
  kind?: "reflection";
}

export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  costUsd: number;
  durationMs: number;
}

export interface TurnResult {
  finalMessage: string;
  /** SDK may emit a new id post-compaction; always returned for session-store update. */
  newSessionId: string;
  usage: TurnUsage;
  errors: string[];
  // KPR-220 Phase 1: execution metrics carried through from RunResult so the
  // dispatcher's RunResult conversion no longer has to zero them. The seven
  // telemetry-shape fields below match agent-runner.ts:121-142 verbatim; the
  // two ephemeral-token fields (5m / 1h cache lifetimes) are needed by
  // Phase 9's convertTurnResult helper so no RunResult field is silently
  // dropped during the dispatcher rewrite.
  llmMs: number;
  toolMs: number;
  toolCalls: number;
  toolSummary: string | null;
  streamed: boolean;
  compactions: number;
  preCompactTokens?: number;
  ephemeral5mTokens?: number;
  ephemeral1hTokens?: number;
}

/** Mirrors AgentRunner.send()'s StreamCallback so adapter-side relay code stays the same. */
export type SpawnTurnStreamCallback = StreamCallback;

/**
 * Default per-agent in-flight spawn budget. Long-lived `maxConcurrent`
 * defaults to 3 (per-thread); per-turn spawns count differently — same
 * thread is still serialized, so the budget bounds parallel spawns across
 * different threads. Plan §D3: "spawn budget calibration becomes a more
 * open-ended dial." Tunable per-agent in a future ticket.
 */
const DEFAULT_PER_AGENT_SPAWN_BUDGET = 5;

/**
 * Voice-adapter sentinel: SDK auth-rebuild-resume errors are retried once
 * with a rebuilt resume id. Mirrors voice-adapter.ts:isAuthError so
 * KPR-219's voice rope-back can route through this same API without
 * regressing.
 */
function isAuthRebuildResumeError(reason: string): boolean {
  return /resolve authentication|credentials\.json|not authenticated|401 Unauthorized|ANTHROPIC_API_KEY|authToken/i.test(
    reason,
  );
}

/**
 * KPR-220 Phase 2: thrown by `withSpawnTicket` when the agent is in
 * `stoppedAgents` at any of three checkpoints (pre-wait, mid-wait,
 * post-lock). Caller decides whether to swallow (reflection) or surface
 * to the channel adapter (per-turn dispatch).
 */
export class AgentStoppedError extends Error {
  constructor(public readonly agentId: string) {
    super(`Agent ${agentId} is stopped`);
    this.name = "AgentStoppedError";
  }
}

/**
 * KPR-220 Phase 2: handle returned by `withSpawnTicket` to the inner
 * lambda. `attachAbort` wires an abort handle (provided by the lambda
 * after constructing its AgentRunner); `abort()` invokes that handle —
 * `stopAgent` walks all live tickets and calls this. Both are null-safe
 * so the HOF's finally cleanup remains intact even when the runner
 * constructor throws before `attachAbort` runs.
 */
export interface SpawnTicket {
  readonly agentId: string;
  readonly threadKey: string;
  readonly workItem: WorkItem;
  attachAbort(handle: () => void): void;
  abort(): void;
}

/**
 * KPR-220 Phase 6: per-(agentId,threadId) reflection coordinator state.
 * The legacy queue-drain trigger is replaced by post-quiescence debounce —
 * each non-reflection turn updates this state and (re)schedules a timer.
 *
 * State machine (B1 in spec):
 * | Event                                | Action                                                                                                                       |
 * |--------------------------------------|------------------------------------------------------------------------------------------------------------------------------|
 * | spawnTurn completes (non-reflection) | Increment pendingReflectionTurns; update lastTurnAt/lastSender/lastResultOk/lastChannelId/lastChannelKind; cancel existing timer; if eligible, schedule debounced timer |
 * | spawnTurn completes (kind=reflection)| Do NOT increment; do NOT schedule; clear pendingReflectionTurns to 0                                                          |
 * | Timer fires                          | Re-check eligibility; if eligible, run reflection; reset pendingReflectionTurns=0                                            |
 * | Eligibility fails decisively         | Cancel timer; reset pendingReflectionTurns=0                                                                                 |
 * | stopAgent / restartAgent / shutdown  | Cancel all timers; delete state                                                                                              |
 */
interface ReflectionState {
  pendingReflectionTurns: number;
  lastTurnAt: number;
  lastSender: WorkItem["sender"];
  lastResultOk: boolean;
  lastChannelId: string;
  lastChannelKind: WorkItem["source"]["kind"];
  timer: NodeJS.Timeout | null;
}

const REFLECTION_PROMPT = [
  "[System — end of conversation reflection]",
  "This conversation is wrapping up. Review what was discussed:",
  "- Were any new facts, decisions, or commitments made?",
  "- Did anything contradict or update what you previously knew?",
  "- Should any existing memories be updated or forgotten?",
  "",
  "If yes, use memory_save, memory_update, or memory_forget now.",
  "If nothing worth saving, do nothing.",
].join("\n");

export class AgentManager {
  private states = new Map<string, AgentState>();
  // Per-thread serialization lock — `agentId:threadId`. Phase 10: queue/runner
  // bookkeeping retired; this set is now co-extensive with `activeSpawnKeys`.
  private processing = new Set<string>();
  private registry: AgentRegistry;
  private memoryManager: MemoryManager;
  private sessionStore: SessionStore;
  private turnTelemetryStore: TurnTelemetryStore;
  private plugins: LoadedPlugin[];
  private seedDirs: string[];
  private skillIndex: SkillIndex;
  private activityLogger?: ActivityLogger;
  private prefetcher?: CodeIndexPrefetcher;
  private teamRoster?: TeamRoster;
  private prefixCache?: PrefixCache;
  private db: Db;
  // Keyed by channelId → timestamps of new-session spawns (within 60s window).
  private spawnWindow = new Map<string, number[]>();
  // KPR-216: in-flight per-turn spawn count per agent. Bounded by
  // DEFAULT_PER_AGENT_SPAWN_BUDGET; over-budget spawns reject immediately
  // so the adapter can decide whether to drop, retry, or fall back.
  private activeSpawnCount = new Map<string, number>();
  // KPR-216: per-turn spawn locks. After Phase 10 this is the canonical
  // "in-flight" set — `processing` and `activeSpawnKeys` are co-extensive.
  private activeSpawnKeys = new Set<string>();
  // KPR-220 Phase 2: per-agent set of in-flight tickets. `stopAgent` walks
  // this and calls `ticket.abort()` to interrupt running spawns. Also
  // backs `getActiveWorkItems(agentId)` (Phase 10).
  private activeTickets = new Map<string, Set<SpawnTicket>>();
  // KPR-220 Phase 2: agents marked stopped. `withSpawnTicket` rejects with
  // AgentStoppedError if the agent is in this set at any of three
  // checkpoints (pre-wait, mid-wait, post-lock).
  private stoppedAgents = new Set<string>();
  // KPR-220 Phase 6: per-(agentId,threadId) reflection coordinator state.
  private reflectionStates = new Map<string, ReflectionState>();
  private reflectionDebounceMs: number;

  constructor(
    registry: AgentRegistry,
    memoryManager: MemoryManager,
    sessionStore: SessionStore,
    db: Db,
    turnTelemetryStore?: TurnTelemetryStore,
    activityLogger?: ActivityLogger,
    prefetcher?: CodeIndexPrefetcher,
    teamRoster?: TeamRoster,
    prefixCache?: PrefixCache,
    options?: { reflectionDebounceMs?: number },
  ) {
    this.registry = registry;
    this.memoryManager = memoryManager;
    this.sessionStore = sessionStore;
    this.db = db;
    // No-op fallback so the rest of the file can call `record` unconditionally.
    // Tests that don't pass a store still exercise the call-shape path without
    // needing a Mongo mock.
    this.turnTelemetryStore = turnTelemetryStore ?? ({ record: async () => {} } as unknown as TurnTelemetryStore);
    this.activityLogger = activityLogger;
    this.prefetcher = prefetcher;
    this.teamRoster = teamRoster;
    this.prefixCache = prefixCache;
    // KPR-220 Phase 6: 30s default; tests inject a small value for speed.
    this.reflectionDebounceMs = options?.reflectionDebounceMs ?? 30_000;
    this.plugins = loadPlugins(appConfig.plugins, hiveHome, { distDir: DIST_DIR });
    this.seedDirs = discoverSeedDirs(seedsDir);
    this.skillIndex = loadSkillIndex(skillsDir, this.plugins, this.seedDirs, this.registry.listIds());
  }

  /** KPR-213: expose the cache so out-of-band consumers (doctor heartbeat, etc.) can read stats. */
  getPrefixCache(): PrefixCache | undefined {
    return this.prefixCache;
  }

  /**
   * KPR-216: per-turn-spawn channels need to resolve `sessionId` for
   * `TurnContext`. Exposed read-only — adapters should not write directly;
   * `spawnTurn` updates the store on completion.
   */
  getSessionStore(): SessionStore {
    return this.sessionStore;
  }

  getPlugins(): LoadedPlugin[] {
    return this.plugins;
  }

  /**
   * KPR-220 Phase 10: derived from `activeTickets` (the canonical in-flight
   * registry post-Phase 10). Production caller `slack-internal-api.ts:143`
   * uses this to resolve thread continuity for the Slack internal-post API.
   */
  getActiveWorkItems(agentId: string): WorkItem[] {
    const tickets = this.activeTickets.get(agentId);
    if (!tickets) return [];
    return [...tickets].map((t) => t.workItem);
  }

  private createRunner(agentId: string): AgentRunner {
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());
    return new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher, this.teamRoster, this.db, this.prefixCache);
  }

  reloadSkills(): void {
    try {
      this.skillIndex = loadSkillIndex(skillsDir, this.plugins, this.seedDirs, this.registry.listIds());
    } catch (err) {
      log.warn("Skill reload failed, retaining previous index", { error: String(err) });
    }
  }

  /**
   * Re-check plugins whose MCP server entries failed to resolve at startup.
   * Called on SIGUSR1 — lets operators recover from a startup race (plugin
   * dist files landing after the engine restart) without a full service
   * restart. See KPR-62.
   */
  rescanPlugins(): void {
    const { rescued, stillBroken } = rescanPluginBrokenServers(this.plugins, hiveHome, { distDir: DIST_DIR });
    const rescuedCount = Object.values(rescued).reduce((n, list) => n + list.length, 0);
    if (rescuedCount > 0) {
      log.info("Plugin MCP servers rescued after rescan", { rescued });
    }
    const stillBrokenCount = Object.values(stillBroken).reduce((n, list) => n + list.length, 0);
    if (stillBrokenCount > 0) {
      log.warn("Plugin MCP servers still unresolvable after rescan", { stillBroken });
    }
  }

  private recordSpawn(channelId: string): void {
    const now = Date.now();
    const windowMs = 60_000;
    const spawns = (this.spawnWindow.get(channelId) ?? []).filter((t) => now - t < windowMs);
    spawns.push(now);
    this.spawnWindow.set(channelId, spawns);
    if (spawns.length > 3) {
      log.warn("Session spawn rate exceeded", { channelId, count: spawns.length, windowSec: 60 });
    }
    // Bounded memory: cap at 200 channels, drop oldest on overflow.
    if (this.spawnWindow.size > 200) {
      const firstKey = this.spawnWindow.keys().next().value;
      if (firstKey) this.spawnWindow.delete(firstKey);
    }
  }

  private ensureState(agentId: string): void {
    if (!this.states.has(agentId)) {
      this.states.set(agentId, {
        id: agentId,
        status: "idle",
        lastActivity: new Date(),
        messagesProcessed: 0,
        errorCount: 0,
        activeThreadCount: 0,
      });
    }
  }

  /**
   * KPR-220 Phase 3: public per-turn entry point for channel adapters.
   * Resolves session, builds TurnContext, and delegates to spawnTurn. The
   * dispatcher's runPerTurnDispatch and (Phase 9) unconditional dispatch
   * use this — keeps session lookup + ctx construction in one place so
   * caller sites stay one-liner.
   */
  async runWorkItemTurn(
    agentId: string,
    item: WorkItem,
    onStream?: SpawnTurnStreamCallback,
  ): Promise<TurnResult> {
    const threadId = item.threadId ?? item.id;
    const sessionId = await this.sessionStore.get(agentId, threadId);

    const ctx: TurnContext = {
      agentId,
      sessionId,
      channelId: item.source.id,
      threadId,
      workItem: item,
      channel: item.source.kind,
    };

    return this.spawnTurn(ctx, onStream);
  }

  /**
   * KPR-216: per-turn spawn API (Phase A). Spawns a fresh `query()` per
   * turn with `options.resume = ctx.sessionId`. Replaces the long-lived
   * AgentRunner.send() path for opt-in channels.
   *
   * KPR-220 Phase 2: lock + budget + ticket lifecycle are handled by
   * `withSpawnTicket`. The lambda here owns shaping, runner construction
   * (with abort wiring), the auth-rebuild retry, and observability.
   *
   * Resume-retry: if the SDK signals an auth-rebuild-resume sentinel
   * (mirrors voice-adapter.ts:316-348 — KPR-219 ropes voice through this
   * same API), retry once with sessionId stripped.
   */
  async spawnTurn(ctx: TurnContext, onStream?: SpawnTurnStreamCallback): Promise<TurnResult> {
    this.ensureState(ctx.agentId);

    if (!this.registry.get(ctx.agentId)) {
      throw new Error(`Unknown agent: ${ctx.agentId}`);
    }

    return this.withSpawnTicket(ctx, async (ticket) => {
      if (!ctx.sessionId) this.recordSpawn(ctx.workItem.source.id);

      // KPR-224 + KPR-226: shape prompt + resolve model router once at the
      // spawnTurn level so both the happy-path call and any auth-rebuild
      // retry use the same shaped values, and recordSpawnObservability sees
      // prompt / modelOverride in scope. Kept INSIDE the HOF lambda so any
      // throw in shaping (e.g., formatFilesForPrompt on malformed file
      // metadata) cannot leak the per-thread lock or budget slot — KPR-226
      // regression prevention.
      const shaping = await this.prepareSpawn(ctx);

      const result = await this.runOneSpawnAttempt(ctx, shaping, ticket, onStream);

      let turnResult: TurnResult;
      if (result.error && isAuthRebuildResumeError(result.error) && ctx.sessionId) {
        log.warn("spawnTurn auth-rebuild-resume — retrying without resume", {
          agentId: ctx.agentId,
          threadId: ctx.threadId,
          reason: result.error,
        });
        const retry = await this.runOneSpawnAttempt({ ...ctx, sessionId: undefined }, shaping, ticket, onStream);
        turnResult = this.finalizeSpawnResult(ctx, retry);
        this.recordSpawnObservability(ctx, shaping.prompt, shaping.modelOverride, retry);
      } else {
        turnResult = this.finalizeSpawnResult(ctx, result);
        this.recordSpawnObservability(ctx, shaping.prompt, shaping.modelOverride, result);
      }

      // KPR-220 Phase 6: post-quiescence reflection scheduling. Reflection
      // turns themselves don't reschedule (kind="reflection" guard).
      if (ctx.kind !== "reflection") {
        this.scheduleReflectionIfEligible(ctx, turnResult);
      }
      return turnResult;
    });
  }

  /**
   * KPR-220 Phase 2: spawn coordinator HOF. Centralizes lock acquisition,
   * budget enforcement, ticket lifecycle, and stop-checking around any
   * per-turn execution. Called by spawnTurn (channel adapters) and
   * runReflectionTurn (Phase 6).
   *
   * Three stop checkpoints (per plan-review BLOCKER fix):
   *  1. Pre-wait: cheap reject before touching state.
   *  2. Mid-wait: re-checked each 25ms cycle of the lock-wait loop.
   *  3. Post-lock: closes the race where stopAgent fires AFTER processing.add
   *     and ticket registration BUT BEFORE fn(ticket) starts running.
   *
   * KPR-225 F1 preserved: budget read+set happens INSIDE the per-thread
   * critical section so contended same-thread spawns can't leak +1 per
   * contention event.
   */
  private async withSpawnTicket<T>(
    ctx: TurnContext,
    fn: (ticket: SpawnTicket) => Promise<T>,
  ): Promise<T> {
    if (this.stoppedAgents.has(ctx.agentId)) {
      throw new AgentStoppedError(ctx.agentId);
    }

    const threadKey = `${ctx.agentId}:${ctx.threadId}`;
    while (this.processing.has(threadKey)) {
      await new Promise((r) => setTimeout(r, 25));
      if (this.stoppedAgents.has(ctx.agentId)) {
        throw new AgentStoppedError(ctx.agentId);
      }
    }
    this.processing.add(threadKey);
    this.activeSpawnKeys.add(threadKey);

    const active = this.activeSpawnCount.get(ctx.agentId) ?? 0;
    const budget = this.spawnBudgetFor(ctx.agentId);
    if (active >= budget) {
      this.processing.delete(threadKey);
      this.activeSpawnKeys.delete(threadKey);
      throw new Error(
        `Spawn budget exceeded for ${ctx.agentId} (${active}/${budget})`,
      );
    }
    this.activeSpawnCount.set(ctx.agentId, active + 1);

    let abortHandle: (() => void) | undefined;
    const ticket: SpawnTicket = {
      agentId: ctx.agentId,
      threadKey,
      workItem: ctx.workItem,
      attachAbort: (handle) => {
        abortHandle = handle;
      },
      abort: () => {
        abortHandle?.();
      },
    };
    const ticketSet = this.activeTickets.get(ctx.agentId) ?? new Set<SpawnTicket>();
    ticketSet.add(ticket);
    this.activeTickets.set(ctx.agentId, ticketSet);
    this.refreshActiveThreadCount(ctx.agentId);
    this.updateStatus(ctx.agentId, "processing");

    // Post-lock stop check: closes the race where stopAgent fires between
    // lock acquisition and fn invocation.
    if (this.stoppedAgents.has(ctx.agentId)) {
      ticketSet.delete(ticket);
      if (ticketSet.size === 0) this.activeTickets.delete(ctx.agentId);
      this.processing.delete(threadKey);
      this.activeSpawnKeys.delete(threadKey);
      const next = (this.activeSpawnCount.get(ctx.agentId) ?? 1) - 1;
      if (next <= 0) this.activeSpawnCount.delete(ctx.agentId);
      else this.activeSpawnCount.set(ctx.agentId, next);
      this.refreshActiveThreadCount(ctx.agentId);
      throw new AgentStoppedError(ctx.agentId);
    }

    try {
      return await fn(ticket);
    } finally {
      ticketSet.delete(ticket);
      if (ticketSet.size === 0) this.activeTickets.delete(ctx.agentId);
      this.processing.delete(threadKey);
      this.activeSpawnKeys.delete(threadKey);
      const next = (this.activeSpawnCount.get(ctx.agentId) ?? 1) - 1;
      if (next <= 0) this.activeSpawnCount.delete(ctx.agentId);
      else this.activeSpawnCount.set(ctx.agentId, next);
      this.refreshActiveThreadCount(ctx.agentId);
      // Status returns to idle when the last in-flight ticket for this agent
      // completes. Only flip when no tickets remain — otherwise an
      // intermediate completion would prematurely mark "idle" while peers
      // are still running.
      if (!this.activeTickets.has(ctx.agentId) && !this.stoppedAgents.has(ctx.agentId)) {
        this.updateStatus(ctx.agentId, "idle");
      }
    }
  }

  /**
   * KPR-220 Phase 4: resolves the in-flight spawn budget for an agent.
   * Fallback chain: agent.spawnBudget → agent.maxConcurrent (deprecated) →
   * engine default (5). Returning the engine default for unknown agents
   * keeps callers safe.
   */
  private spawnBudgetFor(agentId: string): number {
    const def = this.registry.get(agentId);
    return def?.spawnBudget ?? def?.maxConcurrent ?? DEFAULT_PER_AGENT_SPAWN_BUDGET;
  }

  /**
   * KPR-220 Phase 6: an agent is reflection-eligible if its definition lists
   * `memory` or `structured-memory` in EITHER coreServers OR delegateServers.
   * Matches the legacy queue-drain check at agent-manager.ts:750-752 so
   * legacy agent docs that placed memory in delegateServers still get
   * reflection scheduled. KPR-184 forbids that placement for new agents but
   * the runtime is liberal here.
   */
  private hasMemoryServer(agentId: string): boolean {
    const def = this.registry.get(agentId);
    const all = [...(def?.coreServers ?? []), ...(def?.delegateServers ?? [])];
    return all.includes("memory") || all.includes("structured-memory");
  }

  private reflectionKey(agentId: string, threadId: string): string {
    return `${agentId}:${threadId}`;
  }

  /**
   * KPR-220 Phase 6: post-spawnTurn hook. Updates the per-thread reflection
   * state and (re)schedules the debounce timer if eligibility holds.
   *
   * Disabled when `appConfig.memory.reflectionMinTurns <= 0` (per plan-review
   * SHOULD-FIX) — under post-quiescence semantics, treating zero as "fire
   * every turn" would burn a reflection 30s after every active conversation
   * turn. Legacy code shared the predicate but queue-drain semantics masked
   * the consequence.
   */
  private scheduleReflectionIfEligible(ctx: TurnContext, turnResult: TurnResult): void {
    const minTurns = appConfig.memory.reflectionMinTurns;
    if (minTurns <= 0) return;

    const key = this.reflectionKey(ctx.agentId, ctx.threadId);
    const prior = this.reflectionStates.get(key);
    if (prior?.timer) clearTimeout(prior.timer);

    const ok = turnResult.errors.length === 0;
    const state: ReflectionState = {
      pendingReflectionTurns: (prior?.pendingReflectionTurns ?? 0) + 1,
      lastTurnAt: Date.now(),
      lastSender: ctx.workItem.sender,
      lastResultOk: ok,
      lastChannelId: ctx.workItem.source.id,
      lastChannelKind: ctx.workItem.source.kind,
      timer: null,
    };
    this.reflectionStates.set(key, state);

    const eligible =
      this.hasMemoryServer(ctx.agentId) &&
      ok &&
      state.pendingReflectionTurns >= minTurns &&
      ctx.workItem.sender !== "system";
    if (!eligible) return;

    state.timer = setTimeout(() => {
      this.runReflectionTurn(ctx.agentId, ctx.threadId).catch((err) =>
        log.warn("Reflection failed, non-critical", { agentId: ctx.agentId, threadId: ctx.threadId, error: String(err) }),
      );
    }, this.reflectionDebounceMs);
    // Don't keep the event loop alive solely for reflection; matches the
    // long-lived path's pattern of treating reflection as best-effort.
    state.timer.unref?.();
  }

  /**
   * KPR-220 Phase 6: build a synthetic WorkItem from the captured channel
   * context and route through spawnTurn with `kind: "reflection"`. Bypasses
   * runWorkItemTurn because reflection's session lookup happened at the
   * timer site (state was captured at the previous turn).
   */
  private async runReflectionTurn(agentId: string, threadId: string): Promise<void> {
    const key = this.reflectionKey(agentId, threadId);
    const state = this.reflectionStates.get(key);
    if (!state) return;
    state.timer = null;

    // Re-check eligibility at fire time — registry/state may have changed
    // during the debounce window.
    if (this.stoppedAgents.has(agentId)) return;
    if (!this.hasMemoryServer(agentId)) return;

    const sessionId = await this.sessionStore.get(agentId, threadId);
    const workItem: WorkItem = {
      id: `reflection-${threadId}-${Date.now()}`,
      text: REFLECTION_PROMPT,
      threadId,
      sender: "system",
      source: { id: state.lastChannelId, kind: state.lastChannelKind, label: state.lastChannelId },
      timestamp: new Date(),
    };
    const ctx: TurnContext = {
      agentId,
      sessionId,
      channelId: state.lastChannelId,
      threadId,
      workItem,
      channel: state.lastChannelKind,
      kind: "reflection",
    };

    try {
      const result = await this.spawnTurn(ctx);
      log.info("Reflection completed", {
        agentId,
        threadId,
        costUsd: result.usage.costUsd,
        toolCalls: result.toolCalls,
        toolSummary: result.toolSummary || undefined,
      });
    } catch (err) {
      // Swallow non-critically; matches legacy processQueue at line 797.
      log.warn("Reflection failed, non-critical", { agentId, threadId, error: String(err) });
    } finally {
      const after = this.reflectionStates.get(key);
      if (after) {
        after.pendingReflectionTurns = 0;
        after.timer = null;
      }
    }
  }

  private cancelReflectionsFor(agentId: string): void {
    const prefix = `${agentId}:`;
    for (const [key, state] of this.reflectionStates) {
      if (!key.startsWith(prefix)) continue;
      if (state.timer) clearTimeout(state.timer);
      this.reflectionStates.delete(key);
    }
  }

  /** KPR-220 Phase 6: cancel all reflection timers (service shutdown). */
  stopReflections(): void {
    for (const state of this.reflectionStates.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this.reflectionStates.clear();
  }

  private async runOneSpawnAttempt(
    ctx: TurnContext,
    shaping: {
      prompt: string;
      modelOverride: string | undefined;
      resourceLimits: ResourceLimits | undefined;
      routerCostUsd: number;
    },
    ticket: SpawnTicket,
    onStream?: SpawnTurnStreamCallback,
  ): Promise<RunResult> {
    // Fresh runner per spawn — its lazy-built in-process MCPs are therefore
    // also fresh, with channel/thread ctx captured at construction. The
    // long-lived path keeps reusing one runner per agent.
    const runner = this.createRunner(ctx.agentId);
    ticket.attachAbort(() => runner.abort());

    const bgContext: WorkItemContext = {
      adapterId: ctx.workItem.source.adapterId ?? ctx.workItem.source.kind,
      channelId: ctx.channelId,
      channelKind: ctx.workItem.source.kind,
      channelLabel: ctx.workItem.source.label,
      threadId: ctx.threadId,
      slackTs: (ctx.workItem.meta?.slackTs as string) ?? "",
      slackThreadTs: (ctx.workItem.meta?.slackThreadTs as string) ?? "",
    };

    const result = await runner.send(
      shaping.prompt,
      ctx.sessionId,
      onStream,
      bgContext,
      shaping.modelOverride,
      shaping.resourceLimits,
      ctx.systemPromptOverride,
    );
    // KPR-224: model router cost lives outside RunResult; add it here so
    // finalizeSpawnResult and recordSpawnObservability see the full cost.
    result.costUsd += shaping.routerCostUsd;
    return result;
  }

  /**
   * KPR-224: shared shaping helper for both `spawnTurn` (per-turn path) and
   * `processQueue` (legacy path). Centralizes:
   *  - sender identity prepending (`[user:X via Y in #Z]:` for team /
   *    `[Y in #Z, thread=ts]:` for slack-with-sender)
   *  - file-attachment text appending
   *  - model router (modelOverride + resourceLimits + routerCostUsd)
   *
   * Voice carve-out: voice has its own `systemPromptOverride` injection
   * (KPR-219) and explicitly bypasses sender prepending + model router.
   * Returns raw text + no router for `ctx.channel === "voice"`.
   */
  private async prepareSpawn(ctx: TurnContext): Promise<{
    prompt: string;
    modelOverride: string | undefined;
    resourceLimits: ResourceLimits | undefined;
    routerCostUsd: number;
  }> {
    const item = ctx.workItem;

    // Voice carve-out: KPR-219 supplies its own systemPromptOverride and
    // explicitly bypasses prepending + model router. Pin via this branch so
    // future prepareSpawn edits cannot accidentally re-shape voice prompts.
    if (ctx.channel === "voice") {
      return { prompt: item.text, modelOverride: undefined, resourceLimits: undefined, routerCostUsd: 0 };
    }

    const senderLabel = item.senderName ?? item.sender;
    const userId =
      item.source.kind === "team"
        ? (item.meta?.user as string | undefined)
        : undefined;

    let prompt: string;
    if (userId) {
      prompt = `[user:${userId} via ${senderLabel} in #${item.source.label}]: ${item.text}`;
    } else if (item.senderName) {
      const slackThreadTs = item.meta?.slackThreadTs as string | undefined;
      const slackTs = item.meta?.slackTs as string | undefined;
      const threadTs = slackThreadTs ?? slackTs;
      const threadHint = threadTs ? `, thread=${threadTs}` : "";
      prompt = `[${senderLabel} in #${item.source.label}${threadHint}]: ${item.text}`;
    } else {
      prompt = item.text;
    }

    if (item.files?.length) {
      prompt += formatFilesForPrompt(item.files);
    }

    let modelOverride: string | undefined;
    let routerCostUsd = 0;
    let resourceLimits: ResourceLimits | undefined;
    if (appConfig.modelRouter.enabled && item.sender !== "system") {
      try {
        const agentConfig = this.registry.get(ctx.agentId);
        if (agentConfig) {
          const route = await routeModel(item.text, agentConfig.model, agentConfig.resourceTiers);
          modelOverride = route.model !== agentConfig.model ? route.model : undefined;
          routerCostUsd = route.costUsd;
          resourceLimits = route.resourceLimits;
        }
      } catch (err) {
        log.warn("Model router failed, using default", { agentId: ctx.agentId, error: String(err) });
      }
    }

    return { prompt, modelOverride, resourceLimits, routerCostUsd };
  }

  /**
   * KPR-224: shared post-spawn observability helper for both `spawnTurn` and
   * `processQueue`. Records turn telemetry (per-turn cache window),
   * conversation index (semantic recall), and activity audit. All three
   * fail-soft — telemetry/index/audit failures cannot cascade into the turn
   * pipeline (matches existing `processQueue` pattern).
   */
  private recordSpawnObservability(
    ctx: TurnContext,
    prompt: string,
    modelOverride: string | undefined,
    result: RunResult,
  ): void {
    const item = ctx.workItem;

    // Per-turn telemetry — independent of sessionStore (no history in
    // sessionStore.set). Aggregator in `hive doctor` reads this collection.
    if (result.sessionId && !result.aborted) {
      this.turnTelemetryStore
        .record({
          agentId: ctx.agentId,
          threadId: ctx.threadId,
          sessionId: result.sessionId,
          model: modelOverride ?? this.registry.get(ctx.agentId)?.model,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          ephemeral5mTokens: result.ephemeral5mTokens,
          ephemeral1hTokens: result.ephemeral1hTokens,
        })
        .catch(() => {
          // Already logged inside the store via withRetry. Swallow here.
        });
    }

    // Fire-and-forget: index conversation turn for semantic recall
    if (result.text && !result.error) {
      conversationIndex
        .index({
          agentId: ctx.agentId,
          threadId: ctx.threadId,
          channelId: item.source.id,
          source: item.source.kind,
          senderName: item.senderName ?? "unknown",
          timestampUnix: Math.floor(Date.now() / 1000),
          timestamp: new Date().toISOString(),
          inbound: prompt,
          response: result.text,
        })
        .catch((err) =>
          log.warn("Conversation indexing failed", { agentId: ctx.agentId, error: String(err) }),
        );
    }

    // Activity audit
    this.activityLogger?.record({
      agentId: ctx.agentId,
      threadId: ctx.threadId,
      timestamp: new Date(),
      sender: item.sender,
      senderName: item.senderName,
      channel: item.source.label,
      channelKind: item.source.kind,
      model: modelOverride ?? this.registry.get(ctx.agentId)?.model ?? "unknown",
      modelTier: undefined, // Model router tier not currently passed through
      costUsd: result.costUsd,
      durationMs: result.durationMs,
      inputTokens: result.inputTokens,
      outputTokens: result.outputTokens,
      contextWindow: result.contextWindow,
      toolCalls: result.toolCalls,
      toolSummary: result.toolSummary,
      compactions: result.compactions,
      streamed: result.streamed,
      error: result.error,
    });
  }

  private finalizeSpawnResult(ctx: TurnContext, result: RunResult): TurnResult {
    const newSessionId = result.sessionId || ctx.sessionId || "";
    if (result.sessionId && !result.aborted) {
      // Persist post-spawn — captures session-id rotation post-compaction
      // (KPR-211 verified this fires on resume).
      this.sessionStore.set(ctx.agentId, ctx.threadId, result.sessionId, {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        contextWindow: result.contextWindow,
        compactions: result.compactions,
        preCompactTokens: result.preCompactTokens,
      });
    }

    const state = this.states.get(ctx.agentId)!;
    state.messagesProcessed++;
    state.lastActivity = new Date();
    state.currentSessionId = result.sessionId;
    if (result.error) state.errorCount++;

    return {
      finalMessage: result.text,
      newSessionId,
      usage: {
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        cacheReadTokens: result.cacheReadTokens,
        cacheCreationTokens: result.cacheCreationTokens,
        contextWindow: result.contextWindow,
        costUsd: result.costUsd,
        durationMs: result.durationMs,
      },
      errors: result.error ? [result.error] : [],
      llmMs: result.llmMs,
      toolMs: result.toolMs,
      toolCalls: result.toolCalls,
      toolSummary: result.toolSummary || null,
      streamed: result.streamed,
      compactions: result.compactions,
      preCompactTokens: result.preCompactTokens,
      ephemeral5mTokens: result.ephemeral5mTokens,
      ephemeral1hTokens: result.ephemeral1hTokens,
    };
  }

  /**
   * KPR-220 Phase 10: derive `state.activeThreadCount` from `activeSpawnKeys`
   * filtered by `${agentId}:` prefix. Replaces the legacy `activeThreads`
   * map. Called from spawnTurn paths via withSpawnTicket lifecycle.
   */
  private refreshActiveThreadCount(agentId: string): void {
    const state = this.states.get(agentId);
    if (!state) return;
    const prefix = `${agentId}:`;
    let count = 0;
    for (const key of this.activeSpawnKeys) {
      if (key.startsWith(prefix)) count++;
    }
    state.activeThreadCount = count;
  }

  private updateStatus(agentId: string, status: AgentStatus): void {
    const state = this.states.get(agentId);
    if (state) {
      state.status = status;
      log.debug("Agent status changed", { agentId, status });
    }
  }

  getState(agentId: string): AgentState | undefined {
    return this.states.get(agentId);
  }

  getAllStates(): AgentState[] {
    return Array.from(this.states.values());
  }

  stopAgent(agentId: string): void {
    // KPR-220 Phase 5/10: mark stopped first so any concurrent
    // withSpawnTicket call sees it at the post-lock check. Then walk
    // activeTickets and abort everything in flight.
    this.stoppedAgents.add(agentId);
    this.cancelReflectionsFor(agentId);
    const tickets = this.activeTickets.get(agentId);
    if (tickets) {
      for (const ticket of tickets) {
        ticket.abort();
      }
    }
    this.activeTickets.delete(agentId);
    this.refreshActiveThreadCount(agentId);
    this.updateStatus(agentId, "stopped");
  }

  stopAll(): void {
    for (const agentId of this.states.keys()) {
      this.stopAgent(agentId);
    }
    log.info("All agents stopped");
  }

  /**
   * Find which agent was handling a given thread (delegates to SessionStore).
   * Used by Dispatcher for thread-continuity after restart.
   */
  async findAgentForThread(threadId: string): Promise<string | undefined> {
    return this.sessionStore.findAgentByThread(threadId);
  }

  /**
   * Find ALL agents that have sessions for a given thread (delegates to SessionStore).
   * Used by Dispatcher to recover multi-agent participant sets after restart.
   */
  async findAgentsForThread(threadId: string): Promise<string[]> {
    return this.sessionStore.findAgentsByThread(threadId);
  }

  restartAgent(agentId: string): void {
    this.stopAgent(agentId);
    // KPR-220 Phase 5: re-enable acquisitions before clearing session state
    // so any in-flight callers see "running" before retry.
    this.stoppedAgents.delete(agentId);
    this.sessionStore.clearAgent(agentId);
    this.states.set(agentId, {
      id: agentId,
      status: "idle",
      lastActivity: new Date(),
      messagesProcessed: 0,
      errorCount: 0,
      activeThreadCount: 0,
    });
    log.info("Agent restarted", { agentId });
  }

  sweep(): SweepResult {
    let pruned = 0;
    const errors: string[] = [];

    // 1. Remove zombie states — agents removed from registry
    for (const [agentId, state] of this.states) {
      if (!this.registry.get(agentId) && (state.status === "stopped" || state.status === "idle")) {
        this.states.delete(agentId);
        this.activeTickets.delete(agentId);
        pruned++;
        log.info("Zombie agent state removed", { agentId });
      }
    }

    // 2. Detect stuck processing flags. Post-Phase-10, `processing` and
    // `activeSpawnKeys` are co-extensive — a key in `processing` without a
    // matching activeSpawnKey indicates `withSpawnTicket` crashed between
    // adding the lock and the spawn-key (should not happen in the
    // post-HOF world, but the guard rail stays for defensive cleanup).
    for (const threadKey of [...this.processing]) {
      if (this.activeSpawnKeys.has(threadKey)) continue;
      this.processing.delete(threadKey);
      pruned++;
      log.warn("Stuck processing flag cleared", { threadKey });
    }

    return { component: "agent-manager", pruned, retried: 0, bytesFreed: 0, errors };
  }
}
