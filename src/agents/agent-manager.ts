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

interface QueuedMessage {
  message: WorkItem;
  onStream?: StreamCallback;
  resolve: (result: RunResult) => void;
  reject: (error: Error) => void;
}

/**
 * KPR-216: per-turn spawn API. AgentManager.spawnTurn replaces the
 * long-lived AgentRunner.send() path for channels that opt in via
 * `agentManager.perTurnSpawn.<channel>`. Each call spawns a fresh
 * `query()` with `options.resume = ctx.sessionId`; in-process MCP servers
 * are built fresh too so channel/thread context is captured at spawn time
 * (no mutable contextRef across turns).
 *
 * Per-thread serialization (lock key `agentId:threadId`) shares the same
 * `processing` set as the legacy path so concurrent SMS turns on the same
 * thread queue serially even when both paths are simultaneously active
 * (e.g. mid-flag-flip).
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

export class AgentManager {
  private states = new Map<string, AgentState>();
  private queues = new Map<string, QueuedMessage[]>();
  private processing = new Set<string>();
  private activeRunners = new Map<string, Set<AgentRunner>>();
  private activeThreads = new Map<string, Set<string>>();
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
  // Keyed by agentId → list of currently in-flight WorkItems (one per active thread).
  private activeWorkItems = new Map<string, WorkItem[]>();
  // Keyed by channelId → timestamps of new-session spawns (within 60s window).
  private spawnWindow = new Map<string, number[]>();
  // KPR-216: in-flight per-turn spawn count per agent. Bounded by
  // DEFAULT_PER_AGENT_SPAWN_BUDGET; over-budget spawns reject immediately
  // so the adapter can decide whether to drop, retry, or fall back.
  private activeSpawnCount = new Map<string, number>();
  // KPR-216: per-turn spawn locks held in `processing` but with no entry in
  // `activeRunners` (per-turn runners are local to spawnTurn). Sweep uses
  // this to skip its "stuck flag" branch for legitimate in-flight spawns.
  private activeSpawnKeys = new Set<string>();

  constructor(registry: AgentRegistry, memoryManager: MemoryManager, sessionStore: SessionStore, db: Db, turnTelemetryStore?: TurnTelemetryStore, activityLogger?: ActivityLogger, prefetcher?: CodeIndexPrefetcher, teamRoster?: TeamRoster, prefixCache?: PrefixCache) {
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

  getActiveWorkItems(agentId: string): WorkItem[] {
    return this.activeWorkItems.get(agentId) ?? [];
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

  async sendMessage(agentId: string, message: WorkItem, onStream?: StreamCallback): Promise<RunResult> {
    this.ensureState(agentId);
    const threadId = message.threadId ?? message.id;
    const threadKey = `${agentId}:${threadId}`;

    return new Promise<RunResult>((resolve, reject) => {
      const queue = this.queues.get(threadKey) ?? [];
      queue.push({ message, onStream, resolve, reject });
      this.queues.set(threadKey, queue);
      this.processThreadQueue(agentId, threadKey).catch((err) => {
        log.error("processThreadQueue failed unexpectedly", { agentId, threadKey, error: String(err) });
        this.processing.delete(threadKey);
        const activeSet = this.activeThreads.get(agentId);
        if (activeSet) {
          activeSet.delete(threadKey);
          this.updateThreadCount(agentId);
          if (activeSet.size === 0) this.updateStatus(agentId, "idle");
        }
        const queue = this.queues.get(threadKey);
        if (queue) {
          for (const pending of queue) {
            pending.reject(err instanceof Error ? err : new Error(String(err)));
          }
          this.queues.delete(threadKey);
        }
        this.retryDeferredThreads(agentId);
      });
    });
  }

  /**
   * KPR-216: per-turn spawn API (Phase A). Spawns a fresh `query()` per
   * turn with `options.resume = ctx.sessionId`. Replaces the long-lived
   * AgentRunner.send() path for opt-in channels.
   *
   * Lock key reuses the existing `agentId:threadId` `processing` set so
   * concurrent spawns on the same thread queue serially even when the
   * legacy path is simultaneously active for a different thread on the
   * same agent.
   *
   * Per-agent budget: bounded by DEFAULT_PER_AGENT_SPAWN_BUDGET. Over-budget
   * calls reject so the adapter can react (drop / retry / log). No queue —
   * the adapter or dispatcher owns retry policy.
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

    const budget = DEFAULT_PER_AGENT_SPAWN_BUDGET;
    const active = this.activeSpawnCount.get(ctx.agentId) ?? 0;
    if (active >= budget) {
      throw new Error(`Spawn budget exceeded for ${ctx.agentId} (${active}/${budget})`);
    }

    const threadKey = `${ctx.agentId}:${ctx.threadId}`;
    while (this.processing.has(threadKey)) {
      await new Promise((r) => setTimeout(r, 25));
    }
    this.processing.add(threadKey);
    this.activeSpawnKeys.add(threadKey);
    this.activeSpawnCount.set(ctx.agentId, active + 1);

    if (!ctx.sessionId) this.recordSpawn(ctx.workItem.source.id);

    // KPR-224: shape prompt + resolve model router once at the spawnTurn
    // level so both the happy-path call and any auth-rebuild retry use the
    // same shaped values, and recordSpawnObservability sees prompt /
    // modelOverride in scope.
    const shaping = await this.prepareSpawn(ctx);

    try {
      const result = await this.runOneSpawnAttempt(ctx, shaping, onStream);

      if (result.error && isAuthRebuildResumeError(result.error) && ctx.sessionId) {
        log.warn("spawnTurn auth-rebuild-resume — retrying without resume", {
          agentId: ctx.agentId,
          threadId: ctx.threadId,
          reason: result.error,
        });
        const retry = await this.runOneSpawnAttempt({ ...ctx, sessionId: undefined }, shaping, onStream);
        const turnResult = this.finalizeSpawnResult(ctx, retry);
        this.recordSpawnObservability(ctx, shaping.prompt, shaping.modelOverride, retry);
        return turnResult;
      }

      const turnResult = this.finalizeSpawnResult(ctx, result);
      this.recordSpawnObservability(ctx, shaping.prompt, shaping.modelOverride, result);
      return turnResult;
    } finally {
      this.processing.delete(threadKey);
      this.activeSpawnKeys.delete(threadKey);
      const next = (this.activeSpawnCount.get(ctx.agentId) ?? 1) - 1;
      if (next <= 0) this.activeSpawnCount.delete(ctx.agentId);
      else this.activeSpawnCount.set(ctx.agentId, next);
    }
  }

  private async runOneSpawnAttempt(
    ctx: TurnContext,
    shaping: {
      prompt: string;
      modelOverride: string | undefined;
      resourceLimits: ResourceLimits | undefined;
      routerCostUsd: number;
    },
    onStream?: SpawnTurnStreamCallback,
  ): Promise<RunResult> {
    // Fresh runner per spawn — its lazy-built in-process MCPs are therefore
    // also fresh, with channel/thread ctx captured at construction. The
    // long-lived path keeps reusing one runner per agent.
    const runner = this.createRunner(ctx.agentId);

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
    };
  }

  private async processThreadQueue(agentId: string, threadKey: string): Promise<void> {
    // Serialize within same thread
    if (this.processing.has(threadKey)) return;

    const queue = this.queues.get(threadKey);
    if (!queue || queue.length === 0) return;

    // Check concurrency limit
    const config = this.registry.get(agentId);
    const limit = config?.maxConcurrent ?? 3;
    const activeSet = this.activeThreads.get(agentId) ?? new Set();
    if (activeSet.size >= limit) {
      log.debug("Agent at concurrency limit, deferring", { agentId, threadKey, active: activeSet.size, limit });
      return;
    }

    this.processing.add(threadKey);
    activeSet.add(threadKey);
    this.activeThreads.set(agentId, activeSet);
    this.updateStatus(agentId, "processing");
    this.updateThreadCount(agentId);

    const runner = this.createRunner(agentId);
    const runners = this.activeRunners.get(agentId) ?? new Set();
    runners.add(runner);
    this.activeRunners.set(agentId, runners);

    let turnCount = 0;
    let lastItem: QueuedMessage | undefined;
    let lastResult: RunResult | undefined;

    while (queue.length > 0) {
      const item = queue.shift()!;
      // Track active WorkItem for the Slack internal API threading fallback.
      const activeList = this.activeWorkItems.get(agentId) ?? [];
      activeList.push(item.message);
      this.activeWorkItems.set(agentId, activeList);
      try {
        const threadId = item.message.threadId ?? item.message.id;
        const existingSession = await this.sessionStore.get(agentId, threadId);
        if (!existingSession) this.recordSpawn(item.message.source.id);

        const bgContext: WorkItemContext = {
          adapterId: item.message.source.adapterId ?? item.message.source.kind,
          channelId: item.message.source.id,
          channelKind: item.message.source.kind,
          channelLabel: item.message.source.label,
          threadId,
          slackTs: (item.message.meta?.slackTs as string) ?? "",
          slackThreadTs: (item.message.meta?.slackThreadTs as string) ?? "",
        };

        // KPR-224: synthetic TurnContext routes the legacy path through the
        // shared shaping + observability helpers. The carve-out for voice in
        // prepareSpawn is defensive — voice currently flows via routeVoiceTurn,
        // not processQueue, but threading channel: source.kind preserves the
        // invariant if that ever changes.
        const syntheticCtx: TurnContext = {
          agentId,
          sessionId: existingSession,
          channelId: item.message.source.id,
          threadId,
          workItem: item.message,
          channel: item.message.source.kind,
        };
        const { prompt, modelOverride, resourceLimits, routerCostUsd } =
          await this.prepareSpawn(syntheticCtx);

        const result = await runner.send(prompt, existingSession, item.onStream, bgContext, modelOverride, resourceLimits);
        result.costUsd += routerCostUsd;

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
        }

        const state = this.states.get(agentId)!;
        state.messagesProcessed++;
        state.lastActivity = new Date();
        state.currentSessionId = result.sessionId;

        if (result.error) {
          state.errorCount++;
          // Don't set agent to error — other threads may be fine
          // Clear stale session so next message starts fresh
          if (existingSession) {
            this.sessionStore.delete(agentId, threadId);
          }
        }

        item.resolve(result);

        turnCount++;
        lastItem = item;
        lastResult = result;

        // KPR-224: telemetry + conversation index + activity audit via the
        // shared helper. Replaces the inline blocks that previously lived
        // here. Behavior preserved exactly — see prepareSpawn /
        // recordSpawnObservability for the helper bodies.
        this.recordSpawnObservability(syntheticCtx, prompt, modelOverride, result);
      } catch (err) {
        const state = this.states.get(agentId);
        if (state) {
          state.errorCount++;
          state.lastActivity = new Date();
        }
        // Record failed turn in audit trail
        this.activityLogger?.record({
          agentId,
          threadId: item.message.threadId ?? item.message.id,
          timestamp: new Date(),
          sender: item.message.sender,
          senderName: item.message.senderName,
          channel: item.message.source.label,
          channelKind: item.message.source.kind,
          model: config?.model ?? "unknown",
          costUsd: 0,
          durationMs: 0,
          inputTokens: 0,
          outputTokens: 0,
          contextWindow: 0,
          toolCalls: 0,
          toolSummary: "none",
          compactions: 0,
          streamed: false,
          error: String(err),
        });
        item.reject(err instanceof Error ? err : new Error(String(err)));
      } finally {
        const remaining = (this.activeWorkItems.get(agentId) ?? []).filter((w) => w.id !== item.message.id);
        if (remaining.length === 0) this.activeWorkItems.delete(agentId);
        else this.activeWorkItems.set(agentId, remaining);
      }
    }

    // End-of-conversation reflection — prompt agent to save memories
    const allServers = [...(config?.coreServers ?? []), ...(config?.delegateServers ?? [])];
    const hasMemoryServer = allServers.includes("memory")
      || allServers.includes("structured-memory");
    if (
      hasMemoryServer &&
      lastResult &&
      lastItem &&
      !lastResult.error &&
      !lastResult.aborted &&
      turnCount >= appConfig.memory.reflectionMinTurns &&
      lastItem.message.sender !== "system"
    ) {
      try {
        const reflectionPrompt = [
          "[System — end of conversation reflection]",
          "This conversation is wrapping up. Review what was discussed:",
          "- Were any new facts, decisions, or commitments made?",
          "- Did anything contradict or update what you previously knew?",
          "- Should any existing memories be updated or forgotten?",
          "",
          "If yes, use memory_save, memory_update, or memory_forget now.",
          "If nothing worth saving, do nothing.",
        ].join("\n");

        const reflectionResult = await runner.send(reflectionPrompt, lastResult.sessionId);
        log.info("Reflection completed", {
          agentId,
          threadKey,
          turnCount,
          costUsd: reflectionResult.costUsd,
          toolCalls: reflectionResult.toolCalls,
          toolSummary: reflectionResult.toolSummary || undefined,
        });

        // Persist session so next message picks up post-reflection state
        if (reflectionResult.sessionId && !reflectionResult.aborted) {
          const threadId = lastItem.message.threadId ?? lastItem.message.id;
          this.sessionStore.set(agentId, threadId, reflectionResult.sessionId, {
            inputTokens: reflectionResult.inputTokens,
            outputTokens: reflectionResult.outputTokens,
            cacheReadTokens: reflectionResult.cacheReadTokens,
            cacheCreationTokens: reflectionResult.cacheCreationTokens,
            contextWindow: reflectionResult.contextWindow,
            compactions: reflectionResult.compactions,
            preCompactTokens: reflectionResult.preCompactTokens,
          });
        }
      } catch (err) {
        log.warn("Reflection failed, non-critical", { agentId, threadKey, error: String(err) });
      }
    }

    // Cleanup
    runners.delete(runner);
    this.processing.delete(threadKey);
    activeSet.delete(threadKey);
    this.queues.delete(threadKey);
    this.updateThreadCount(agentId);

    if (activeSet.size === 0) {
      this.updateStatus(agentId, "idle");
    }

    // Pick up deferred threads that were waiting for a slot
    this.retryDeferredThreads(agentId);
  }

  private updateThreadCount(agentId: string): void {
    const state = this.states.get(agentId);
    if (state) {
      state.activeThreadCount = this.activeThreads.get(agentId)?.size ?? 0;
    }
  }

  private retryDeferredThreads(agentId: string): void {
    const prefix = `${agentId}:`;
    for (const [threadKey, queue] of this.queues) {
      if (threadKey.startsWith(prefix) && queue.length > 0 && !this.processing.has(threadKey)) {
        this.processThreadQueue(agentId, threadKey);
        break; // One at a time to respect limit
      }
    }
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
    const runners = this.activeRunners.get(agentId);
    if (runners) {
      for (const runner of runners) {
        runner.abort();
      }
      runners.clear();
    }
    this.activeRunners.delete(agentId);
    this.activeThreads.delete(agentId);
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
        this.activeRunners.delete(agentId);
        this.activeThreads.delete(agentId);
        pruned++;
        log.info("Zombie agent state removed", { agentId });
      }
    }

    // 2. Detect stuck processing flags
    for (const threadKey of this.processing) {
      const agentId = threadKey.split(":")[0];
      const runners = this.activeRunners.get(agentId);
      if (!runners || runners.size === 0) {
        // KPR-216: per-turn spawns hold `processing` without populating
        // `activeRunners` (their runner is local to spawnTurn). Skip.
        if (this.activeSpawnKeys.has(threadKey)) continue;
        // No active runners but processing flag is set — stuck
        this.processing.delete(threadKey);
        const activeSet = this.activeThreads.get(agentId);
        if (activeSet) {
          activeSet.delete(threadKey);
          this.updateThreadCount(agentId);
          if (activeSet.size === 0) this.updateStatus(agentId, "idle");
        }
        pruned++;
        log.warn("Stuck processing flag cleared", { threadKey, agentId });

        // Try to restart the queue for this thread
        const queue = this.queues.get(threadKey);
        if (queue && queue.length > 0) {
          this.processThreadQueue(agentId, threadKey).catch((err) => {
            log.error("Failed to restart stuck queue", { threadKey, error: String(err) });
          });
        }
      }
    }

    // 3. Retry deferred threads for ALL agents with pending queues
    const agentIds = new Set<string>();
    for (const threadKey of this.queues.keys()) {
      agentIds.add(threadKey.split(":")[0]);
    }
    for (const agentId of agentIds) {
      this.retryDeferredThreads(agentId);
    }

    return { component: "agent-manager", pruned, retried: 0, bytesFreed: 0, errors };
  }
}
