import { createLogger } from "../logging/logger.js";
import type { AgentState, AgentStatus } from "../types/agent-config.js";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import { AgentRunner, DIST_DIR, type RunResult, type StreamCallback, type WorkItemContext } from "./agent-runner.js";
import { AgentRegistry } from "./agent-registry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SessionStore } from "./session-store.js";
import type { TurnHistoryStore } from "./turn-history-store.js";
import type { TurnTelemetryStore } from "./turn-telemetry.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import type { Db } from "mongodb";
import { formatFilesForPrompt } from "../files/file-processor.js";
import { routeModel, modelToTier, resolveResourceLimits, type ResourceLimits } from "./model-router.js";
import { getLLMRegistry } from "../llm/registry.js";
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
import type { MemoryLifecycle } from "../memory/memory-lifecycle.js";
import { ClaudeAgentAdapter } from "./provider-adapters/claude-agent-adapter.js";
import {
  CodexSubscriptionAdapter,
  type CodexReasoningEffort,
} from "./provider-adapters/codex-subscription-adapter.js";
import { GeminiInteractionsAdapter } from "./provider-adapters/gemini-interactions-adapter.js";
import { OpenAIAgentsAdapter } from "./provider-adapters/openai-agents-adapter.js";
import type { AgentProviderAdapter, AgentProviderId, ReasoningEffort } from "./provider-adapters/types.js";
import { persistsResumableHandle, sessionSemanticsFor } from "./provider-adapters/types.js";
import {
  assembleProviderTurn,
  buildNestedDelegateAssembly,
  type DelegateTurnRunner,
  type ProviderTurnAssembly,
} from "./provider-adapters/turn-assembly.js";
import {
  isLaneAProvider,
  resolvePassthroughSpawn,
  type PassthroughSpawnConfig,
} from "./provider-adapters/passthrough-providers.js";
import { ProviderCircuitBreakerRegistry } from "./provider-circuit-breaker.js";
import { classifyThrown, classifyTurnResult } from "./provider-adapters/error-classification.js";

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
  /**
   * KPR-313: provider tag of the stored session — set wherever sessionId is
   * resolved from the session store (runWorkItemTurn, reflection reads,
   * voice's eligibility-filtered read). Consumed by spawnTurn's
   * session-identity guard. undefined ⇒ nothing known about the row's
   * producer (first turn, or a caller that resolved no session).
   */
  sessionProvider?: AgentProviderId;
  /**
   * KPR-313: set ONLY by spawnTurn's session-identity guard when this turn
   * starts fresh due to a provider change; prepareSpawn prepends the handoff
   * annotation. Never set by callers.
   */
  sessionHandoff?: boolean;
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
  /**
   * KPR-307: propagated from RunResult.timedOut (KPR-306 — runner deadline
   * fired). Consumed by the dispatcher's post-turn outage gate: a hang-type
   * timeout leaves `errors` empty (the abort path returns before a provider
   * error string is captured), so the flag is the only signal.
   */
  timedOut?: boolean;
  /** KPR-307: propagated from RunResult.aborted (operator abort or deadline abort). */
  aborted?: boolean;
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

type ProviderModelRoute =
  | { provider: "claude"; model: string }
  | { provider: "openai"; model: string; reasoningEffort?: CodexReasoningEffort }
  | { provider: "gemini"; model: string; reasoningEffort?: CodexReasoningEffort }
  | { provider: "codex"; model: string; reasoningEffort?: CodexReasoningEffort }
  // KPR-346 (§D2): Lane A passthrough — Claude runtime, foreign endpoint.
  // reasoningEffort survives splitProviderModel and delivers via the Claude
  // adapter's existing effort channel (clamped in prepareSpawn, §D6).
  | { provider: "kimi" | "deepseek"; model: string; reasoningEffort?: CodexReasoningEffort };

const REASONING_EFFORTS = new Set<CodexReasoningEffort>(["minimal", "none", "low", "medium", "high", "xhigh"]);

function resolveProviderModel(model: string): ProviderModelRoute {
  const normalized = model.trim();
  const slash = normalized.indexOf("/");
  if (slash <= 0) return { provider: "claude", model: normalized };

  const provider = normalized.slice(0, slash).toLowerCase();
  const { model: providerModel, reasoningEffort } = splitProviderModel(normalized.slice(slash + 1));
  if (provider === "codex" || provider === "openai-codex") {
    return { provider: "codex", model: providerModel, reasoningEffort };
  }
  if (provider === "openai") {
    return { provider: "openai", model: providerModel, reasoningEffort };
  }
  if (provider === "gemini" || provider === "google-gemini") {
    return { provider: "gemini", model: providerModel, reasoningEffort };
  }
  if (provider === "kimi") {
    return { provider: "kimi", model: providerModel, reasoningEffort };
  }
  if (provider === "deepseek") {
    return { provider: "deepseek", model: providerModel, reasoningEffort };
  }

  return { provider: "claude", model: normalized };
}

function splitProviderModel(providerModel: string): { model: string; reasoningEffort?: CodexReasoningEffort } {
  const colon = providerModel.lastIndexOf(":");
  if (colon <= 0 || colon === providerModel.length - 1) return { model: providerModel };

  const suffix = providerModel.slice(colon + 1);
  if (!REASONING_EFFORTS.has(suffix as CodexReasoningEffort)) return { model: providerModel };
  return { model: providerModel.slice(0, colon), reasoningEffort: suffix as CodexReasoningEffort };
}

/**
 * KPR-311 → KPR-338: per-turn spawn shaping — shaped prompt plus the agent's
 * static route. Post-KPR-338 the route IS the static route on every path
 * (resolveProviderModel(agent.model)): the router no longer names models or
 * providers, so the W3 provider clamp (R-311.1) survives structurally rather
 * than as a branch. The route keeps the KPR-306 breaker permit — acquired on
 * the static provider before any shaping — keyed to the provider that
 * actually runs, and keeps providerFor() (KPR-307) consistent. Cross-provider
 * per-turn routing stays parked (kpr-311-spec §5 → KPR-337).
 */
interface SpawnShaping {
  prompt: string;
  /** The agent's static route — consumed by createProviderAdapter. */
  route: ProviderModelRoute;
  /**
   * KPR-312 → KPR-338: per-turn reasoning effort — the classifier's ONLY
   * surviving output. Carried BESIDE the route, never in it (R-312.3 channel,
   * meaning untouched). Set only by the router merge branch, which is only
   * reached when the static model is effort-capable (prepareSpawn's skip
   * guarantees deliverability); undefined on voice/skip/failure paths and
   * for pilots. KPR-346: ALSO set by prepareSpawn's Lane A branch (clamped
   * static :effort suffix — §D6).
   */
  effortOverride: ReasoningEffort | undefined;
  /** Static-tier execution bounds — set ONLY on the router-on path (KPR-338
   *  path-preserving rule); undefined elsewhere so the runner's per-agent
   *  legacy fallback (timeoutMs/maxTurns/budgetUsd) stays live config. */
  resourceLimits: ResourceLimits | undefined;
  routerCostUsd: number;
}

/**
 * KPR-313 §3.4: hive-owned handoff annotation, prepended by prepareSpawn
 * when spawnTurn's session-identity guard reset thread continuity. Binding
 * content requirements (spec): the engine changed, prior turns in this
 * thread are not in context, agent memory is intact. The conversation_search
 * recall clause is Claude-target only — pilot adapters advertise zero tools
 * until KPR-348 wires the bridge — KPR-347 deleted the assertToolFreePilot
 * guards, so the pilot variant must not suggest a tool the
 * agent cannot reach. Voice never sees either (carve-out returns first;
 * voice's handoff is its full-transcript re-send).
 */
const SESSION_HANDOFF_NOTICE_CLAUDE =
  "[System notice: this thread's session continuity was reset because your underlying engine changed. Earlier turns in this thread are not in your context, but your agent memory is intact — use conversation_search if you need prior context from this thread.]\n";
const SESSION_HANDOFF_NOTICE_PILOT =
  "[System notice: this thread's session continuity was reset because your underlying engine changed. Earlier turns in this thread are not in your context, but your agent memory is intact.]\n";

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
 * KPR-350 (§D3): stale server-handle sentinel for server-resumable routes.
 * Matches the Responses previous-response-gone surface ("Previous response
 * with id 'resp_…' not found", 404/400-shaped, incl. the previous_response_id
 * param variant). Deliberately NARROW — bounded gaps, anchored on the
 * "previous response(_id)" prefix — because a false positive silently drops
 * one turn's context (the self-heal retries fresh). Docs/community-sourced;
 * refined against KPR-351's live capture (L2) if the production string
 * differs. Exported for the narrowness-matrix unit pins.
 *
 * KPR-352 (§D3): a third alternate matches the gemini adapter's hive-owned
 * stale-resume sentinel ("gemini interaction resume rejected"). Unlike the
 * openai alternates (which match the vendor's prose surface), the gemini
 * sentinel is emitted deterministically by the adapter — only for a round-1
 * 4xx whose carried previous_interaction_id was the persisted handle — so the
 * matcher is a sentinel check, not a prose guess.
 */
export function isStaleServerHandleError(reason: string): boolean {
  return (
    /previous response[\s\S]{0,80}?(not found|expired|no longer (?:exists|available))/i.test(reason) ||
    /previous_response_id[\s\S]{0,80}?(not found|invalid|expired)/i.test(reason) ||
    // KPR-352 (§D3): the gemini adapter's hive-owned sentinel — emitted ONLY
    // for round-1 status-400 failures (the live-probed set; T0 spike showed
    // fabricated AND malformed ids both 400) whose carried
    // previous_interaction_id was the persisted sessions-store handle, gated
    // by a message discriminator so generic malformed-request 400s stay
    // ordinary provider faults. If a genuinely aged-out handle is ever
    // observed to 403 (55d/1d retention — unprobeable at spike time), fold
    // that status + a permission-message discriminator into the adapter's
    // STALE_HANDLE_STATUSES/STALE_HANDLE_MESSAGE, not here.
    /gemini interaction resume rejected/i.test(reason)
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
 * after constructing its provider adapter); `abort()` invokes that handle —
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
 * KPR-220 Phase 11 / spec S6: read-only snapshot of the spawn coordinator's
 * per-agent state. Consumers (health-reporter, ws-adapter agent list, doctor
 * heartbeat) project this into their UI shapes — no internal map access.
 *
 * `stopped` (spec S8) reflects `stoppedAgents.has(agentId)` so the doctor +
 * dashboard surfaces stopped agents distinctly from "idle" ones.
 */
export interface CoordinatorSnapshotPerAgent {
  /** Number of in-flight spawn tickets for this agent. */
  activeSpawns: number;
  /** Per-thread spawn keys currently in `processing` for this agent. */
  activeThreadKeys: string[];
  /** Resolved budget for this agent (agent.spawnBudget → maxConcurrent → engine default). */
  budget: number;
  /** Source of the budget — which fallback fired. */
  budgetSource: "spawnBudget" | "maxConcurrent" | "default";
  /** How many times withSpawnTicket has rejected this agent for budget over the lifetime of the process. */
  saturationCount: number;
  /** Unix epoch (ms) of the most recent saturation event, or null if never. */
  lastSaturationAt: number | null;
  /** Unix epoch (ms) of the most recent spawn start, or null if never. */
  lastSpawnAt: number | null;
  /** Most recent error-string surfaced by a spawn (truncated to 240 chars), or null. */
  lastError: string | null;
  /** Whether the agent is in `stoppedAgents` (spec S8). */
  stopped: boolean;
}

export interface CoordinatorSnapshot {
  perAgent: Record<string, CoordinatorSnapshotPerAgent>;
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
  private memoryLifecycle?: MemoryLifecycle;
  /** KPR-353 (§D3/§D4): stateless-replay turn history. Optional so bare test
   *  constructions stay valid; production wiring (index.ts) always passes it.
   *  Absent ⇒ codex turns run stateless (pre-353 floor) and the handoff hook
   *  no-ops. */
  private turnHistoryStore?: TurnHistoryStore;
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
  // KPR-220 Phase 11: per-agent saturation tracking. Incremented in
  // `recordSaturation` from `withSpawnTicket`'s budget-exceeded throw path.
  private saturationEvents = new Map<string, { count: number; lastAt: number }>();
  // KPR-220 Phase 11: most-recent spawn-start timestamp per agent.
  private lastSpawnAt = new Map<string, number>();
  // KPR-220 Phase 11: most-recent spawn error per agent (truncated).
  private lastSpawnError = new Map<string, string>();
  /** KPR-338 D1: warn-once per model id when effort hints are disabled for an
   *  off-catalog (non-haiku-tier) static model — supportsEffort is
   *  conservative (unknown ⇒ false) and the operator deserves a signal. */
  private readonly effortIncapableWarned = new Set<string>();
  /** KPR-346 (§D6): once-per-(agent,model) warn when a Lane A :effort suffix
   *  is outside the SDK-deliverable {low,medium,high} set. */
  private readonly laneAEffortClampWarned = new Set<string>();
  /**
   * KPR-306: per-provider circuit breakers. Read-only surface — KPR-307's
   * dispatcher-side consumer and the CircuitBreakerHeartbeat both reach it
   * via the AgentManager instance (no new wiring surface).
   */
  readonly circuitBreakers: ProviderCircuitBreakerRegistry;

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
    memoryLifecycle?: MemoryLifecycle,
    turnHistoryStore?: TurnHistoryStore,
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
    this.memoryLifecycle = memoryLifecycle;
    this.turnHistoryStore = turnHistoryStore;
    // KPR-220 Phase 6: 30s default; tests inject a small value for speed.
    this.reflectionDebounceMs = options?.reflectionDebounceMs ?? 30_000;
    // KPR-306: registry defaults internally when appConfig.circuitBreaker is
    // absent (test config mocks omit it).
    this.circuitBreakers = new ProviderCircuitBreakerRegistry(appConfig.circuitBreaker);
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

  /**
   * KPR-311 → KPR-338: the route is the agent's static per-turn route
   * derived by prepareSpawn (static by construction post-KPR-338 — clamp
   * invariant, R-311.1) — the static agent.model prefix is no longer
   * re-resolved here, so the breaker permit and the adapter always key off
   * the same resolution (R7). Single call site (runOneSpawnAttempt);
   * parameter required, no default. KPR-347: async — Lane B construction
   * awaits turn assembly; Claude branch has no awaits and is unchanged in
   * logic.
   */
  private async createProviderAdapter(
    agentId: string,
    route: ProviderModelRoute,
    workItemContext?: WorkItemContext,
  ): Promise<AgentProviderAdapter> {
    const config = this.registry.get(agentId);
    if (!config) throw new Error(`Unknown agent: ${agentId}`);
    const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());

    // KPR-346 (§D3/§D4): Lane A passthrough — credential + model resolved
    // per spawn, BEFORE runner construction. A missing credential throws
    // TurnAssemblyError here, inside runOneSpawnAttempt's recorded try:
    // classifyThrown short-circuits it to non-provider, so a config fault
    // never counts toward the foreign breaker's trip streak and never
    // engages the outage queue (epic §D2).
    let laneAPassthrough: PassthroughSpawnConfig | undefined;
    if (route.provider === "kimi" || route.provider === "deepseek") {
      laneAPassthrough = resolvePassthroughSpawn(route.provider, route.model, {
        configuredModel: appConfig[route.provider].agentModel,
        instanceId: appConfig.instance.id,
      });
    }

    const runner = new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher, this.teamRoster, this.db, this.prefixCache, this.memoryLifecycle, laneAPassthrough ? { laneAPassthrough } : undefined);
    if (route.provider === "claude") {
      return new ClaudeAgentAdapter(runner);
    }
    // KPR-346 (§D3): Lane A runs the FULL Claude runtime against the vendor
    // endpoint — ClaudeAgentAdapter, never the Lane B assembly path below.
    // The adapter's `readonly provider = "claude"` stays as-is per canon:
    // the adapter class is an execution-path detail; every ops surface
    // (breaker, outage gate, session tag, KPR-313 guard) keys on the ROUTE.
    if (route.provider === "kimi" || route.provider === "deepseek") {
      return new ClaudeAgentAdapter(runner);
    }

    // KPR-347 (§D5): Lane B per-spawn assembly — real inventory through the
    // compatibility partition; KPR-349: instructions are the real prompt from
    // buildProviderInstructions (via the runner's buildProviderPrompt),
    // assembled inside assembleProviderTurn. Assembly throws are
    // TurnAssemblyError (classifies non-provider inside the caller's
    // recorded try).
    // KPR-354 (§D5): manager-owned nested-turn runner for delegate
    // subagents. Built BEFORE assembly and carried on it as an opaque
    // callback (provider-blindness canon — provider resolution and budget
    // machinery stay here). The body runs only inside the parent adapter's
    // runTurn, after `parentAssembly` is assigned below. NEVER throws —
    // every path resolves model-visible text (D5.7); tool faults stay
    // breaker-invisible (no breaker acquire/record anywhere in the body).
    // Forward-referenced binding: the closure below reads parentAssembly at
    // call-time, assigned after assembly is built — must be `let`.
    // eslint-disable-next-line prefer-const
    let parentAssembly: ProviderTurnAssembly | undefined;
    const delegateTurnRunner: DelegateTurnRunner = async (call) => {
      const startedAt = Date.now();
      // D5.1 + D5.2 (spec-review directive 3): stop check and budget
      // check-and-increment are SYNCHRONOUS with no await between them —
      // atomic under parallel openai Task calls (no interleaving without an
      // await point). Denials never increment.
      if (this.stoppedAgents.has(agentId)) {
        return "Task denied: agent is stopped.";
      }
      const active = this.activeSpawnCount.get(agentId) ?? 0;
      const budget = this.spawnBudgetFor(agentId);
      if (active >= budget) {
        this.recordSaturation(agentId, active, budget);
        return `Task denied: spawn budget exhausted (${active}/${budget}). Retry later or proceed without the delegate.`;
      }
      this.activeSpawnCount.set(agentId, active + 1);
      // Slot held from here; released in the finally (withSpawnTicket's
      // delete-at-zero idiom). Deliberately NOT touched (D5.2 + directive 2):
      // the per-thread lock (the parent holds agentId:threadId for the whole
      // outer turn — a nested wait would deadlock permanently; same-thread
      // serialization is a message-level concern the parent already
      // provides), lastSpawnAt, updateStatus, breaker acquire/record,
      // sessionStore, reflection scheduling.
      let removeAbortListener: (() => void) | undefined;
      try {
        const { assembly: nestedAssembly, maxTurns } = buildNestedDelegateAssembly({
          config,
          delegate: call.delegate,
          entry: call.entry,
          workItemContext: call.workItemContext,
          // "" arm is dead by construction: the delegate callback can only run
          // after the parent adapter is constructed, which requires assembly.
          sessionCwd: parentAssembly?.sessionCwd ?? "",
        });
        let nested: AgentProviderAdapter;
        if (route.provider === "openai") {
          nested = new OpenAIAgentsAdapter({
            name: `${config.name}:${call.delegate}`,
            model: route.model || appConfig.openai.agentModel || "gpt-5.4-mini",
            assembly: nestedAssembly,
          });
        } else if (route.provider === "codex") {
          nested = new CodexSubscriptionAdapter({
            name: `${config.name}:${call.delegate}`,
            model: route.model || appConfig.codex.agentModel,
            reasoningEffort: route.reasoningEffort,
            assembly: nestedAssembly,
            // NO historyStore / agentId (G4): the KPR-353 wiring then skips
            // replay and persist by construction — provider_turn_history is
            // provably untouched by nested turns.
          });
        } else if (route.provider === "gemini") {
          nested = new GeminiInteractionsAdapter({
            name: `${config.name}:${call.delegate}`,
            model: route.model || appConfig.gemini.agentModel || "gemini-3.6-flash",
            apiKey: appConfig.gemini.apiKey || undefined,
            reasoningEffort: route.reasoningEffort,
            assembly: nestedAssembly,
            // Session-less by construction (§D6): no sessionId flows into the
            // nested runTurn below, the nested turn starts a fresh chain, and
            // the D5.7 shaping discards the final id — nothing persists.
            // Accepted residue: unreferenced store:true interactions self-
            // expire at vendor retention (55d paid) — KPR-350's 30d shape.
          });
        } else {
          // Unreachable while LaneBProviderId = {openai, codex, gemini} —
          // kept as containment for a future provider that ships tool-less
          // (KPR-354 belt-and-braces; §D6).
          return `Delegate turn failed (${call.delegate}): provider ${String((route as { provider: string }).provider)} does not execute tools`;
        }
        if (call.signal.aborted) return `Delegate turn aborted (${call.delegate}).`;
        // D5.5 (spec-review directive 1): the listener body is try/caught —
        // an abort() throw inside EventTarget dispatch would NOT surface
        // through this async frame and would escape all containment; the
        // never-throws contract is structural, not assumed.
        const onAbort = () => {
          try {
            nested.abort();
          } catch (err) {
            log.warn("Nested delegate abort threw — contained (KPR-354 D5.5)", {
              agentId,
              delegate: call.delegate,
              error: String(err),
            });
          }
        };
        call.signal.addEventListener("abort", onAbort, { once: true });
        removeAbortListener = () => call.signal.removeEventListener("abort", onAbort);
        const result = await nested.runTurn({
          prompt: call.prompt,
          workItemContext: call.workItemContext,
          // Only maxTurns is consumed on Lane B (openai run options + codex
          // round budget); timeoutMs/budgetUsd are Claude-lane concepts —
          // neutral values.
          resourceLimits: { maxTurns, timeoutMs: 600_000, budgetUsd: 0 },
        });
        // D5.8: one info log keyed on the ROUTE provider (resolved-provider
        // attribution canon). Nested usage is logged, not folded into the
        // parent RunResult (⚠ spec Key Points; costUsd is 0 on both Lane B
        // surfaces anyway).
        log.info("Nested delegate turn complete", {
          agentId,
          provider: route.provider,
          delegate: call.delegate,
          durationMs: Date.now() - startedAt,
          toolCalls: result.toolCalls,
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          ...(result.error ? { error: result.error } : {}),
        });
        // D5.7 result shaping (never throws). Nested sessionId DISCARDED;
        // sessionStore untouched (G4).
        if (result.aborted) return `Delegate turn aborted (${call.delegate}).`;
        if (result.error) return `Delegate turn failed (${call.delegate}): ${result.error}`;
        return result.text || `Delegate '${call.delegate}' returned no output.`;
      } catch (err) {
        // Belt-and-suspenders (D5.7): the runner contract is never-throws.
        return `Delegate turn failed (${call.delegate}): ${err instanceof Error ? err.message : String(err)}`;
      } finally {
        removeAbortListener?.();
        const next = (this.activeSpawnCount.get(agentId) ?? 1) - 1;
        if (next <= 0) this.activeSpawnCount.delete(agentId);
        else this.activeSpawnCount.set(agentId, next);
      }
    };

    const assembly = await assembleProviderTurn({
      runner,
      config,
      provider: route.provider,
      workItemContext,
      delegateTurnRunner,
    });
    parentAssembly = assembly;

    if (route.provider === "codex") {
      return new CodexSubscriptionAdapter({
        name: config.name,
        model: route.model || appConfig.codex.agentModel,
        reasoningEffort: route.reasoningEffort,
        assembly,
        // KPR-353 (§D3): hive-persisted stateless-replay history. agentId is
        // config.id (the store key); `name` above stays the display label.
        historyStore: this.turnHistoryStore,
        agentId: config.id,
      });
    }

    if (route.provider === "openai") {
      return new OpenAIAgentsAdapter({
        name: config.name,
        model: route.model || appConfig.openai.agentModel || "gpt-5.4-mini",
        assembly,
      });
    }

    return new GeminiInteractionsAdapter({
      name: config.name,
      // KPR-352 plan-time pin: Interactions-supported default (pre-352
      // literal "gemini-2.5-flash" predates the surface).
      model: route.model || appConfig.gemini.agentModel || "gemini-3.6-flash",
      apiKey: appConfig.gemini.apiKey || undefined,
      reasoningEffort: route.reasoningEffort,
      assembly,
    });
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
    const stored = await this.sessionStore.get(agentId, threadId);

    const ctx: TurnContext = {
      agentId,
      sessionId: stored?.sessionId,
      sessionProvider: stored?.provider,
      channelId: item.source.id,
      threadId,
      workItem: item,
      channel: item.source.kind,
    };

    return this.spawnTurn(ctx, onStream);
  }

  /**
   * KPR-307: the provider an agent's turns route to — additive read-only
   * surface for the dispatcher's post-turn outage gate. One-liner over the
   * same resolveProviderModel the KPR-306 wrap point uses, so dispatcher and
   * breaker always agree on the provider key.
   */
  providerFor(agentId: string): AgentProviderId | null {
    const agentConfig = this.registry.get(agentId);
    if (!agentConfig) return null;
    return resolveProviderModel(agentConfig.model).provider;
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
      // KPR-306: circuit-breaker admission — FIRST thing in the lambda, so a
      // fast-fail spends no session I/O and no model-router call. Throws
      // ProviderCircuitOpenError while the provider's circuit is open;
      // withSpawnTicket's finally releases the per-thread lock, budget slot,
      // and ticket set on the way out (no new cleanup path). The lock is
      // held for microseconds during a fast-fail — no I/O precedes the throw.
      const route = resolveProviderModel(this.registry.get(ctx.agentId)?.model ?? "");
      const permit = this.circuitBreakers.acquire(route.provider, {
        agentId: ctx.agentId,
        threadId: ctx.threadId,
      });

      // KPR-220 Phase 15: re-resolve sessionId post-lock for reflection
      // turns. The reflection timer may have fired while a user turn was
      // in flight on the same thread; that turn could have rotated the
      // session post-compaction, so the sessionId captured at timer-fire
      // time is potentially stale. Reading sessionStore HERE (after the
      // per-thread lock is held) closes the race because no other turn
      // can be writing to it. Non-reflection callers keep their original
      // ctx.sessionId — they always resolve immediately before calling
      // spawnTurn, so the window is microseconds and tolerated.
      let effectiveCtx = ctx;
      if (ctx.kind === "reflection") {
        const fresh = await this.sessionStore.get(ctx.agentId, ctx.threadId);
        // KPR-313: FIELD-wise staleness compare. get() now returns a ref — a
        // naive `fresh !== ctx.sessionId` would compare ref-vs-string, always
        // mismatch, and (worse) assign a ref where a string id belongs.
        if (fresh?.sessionId !== ctx.sessionId || fresh?.provider !== ctx.sessionProvider) {
          effectiveCtx = { ...ctx, sessionId: fresh?.sessionId, sessionProvider: fresh?.provider };
        }
      }

      // KPR-313: session-identity guard. Resume only a same-provider handle;
      // on any provider transition with prior thread state, hand off (fresh +
      // memory + annotation). Hot path is a pure compare — zero I/O; R7 order
      // (acquire → re-resolve → guard → recordSpawn → prepareSpawn → record)
      // intact. On trip ONLY: one authoritative post-lock store re-read —
      // non-reflection turns capture sessionId+tag PRE-lock (runWorkItemTurn),
      // so under same-thread contention across a provider transition the
      // captured tag is stale by a full turn; the re-read adopts the queue-
      // predecessor's already-switched session instead of dropping its
      // exchange (⚠A9). The trip condition keys on sessionProvider alone, not
      // sessionId: a codex-tagged row with sessionId:"" read by a claude turn
      // has nothing to resume but DOES have invisible prior thread turns —
      // the annotation must still fire. `route` is the acquire-time static
      // route; under the W3 clamp it is provably ≡ shaping.route.provider
      // (KPR-311 §5). Lifting the clamp re-keys acquire AND this guard
      // together (parked: kpr-311-spec §5 → KPR-337). The re-read is
      // withRetry fail-soft (never throws) and dereferences no registry —
      // no new throw surface inside the R7 window.
      if (effectiveCtx.sessionProvider && effectiveCtx.sessionProvider !== route.provider) {
        const fresh = await this.sessionStore.get(ctx.agentId, ctx.threadId); // post-lock ⇒ authoritative
        if (fresh?.provider === route.provider) {
          // A queued predecessor already performed the switch — adopt its
          // state, no handoff. fresh.sessionId may itself be undefined
          // (predecessor was a stateless pilot turn): the turn then runs
          // fresh WITHOUT an annotation, which is exactly the same-provider
          // stateless case where no transition annotation is owed.
          effectiveCtx = { ...effectiveCtx, sessionId: fresh.sessionId, sessionProvider: fresh.provider };
        } else {
          log.warn("Session provider mismatch — fresh session with memory handoff (KPR-313)", {
            agentId: ctx.agentId,
            threadId: ctx.threadId,
            stored: effectiveCtx.sessionProvider,
            turn: route.provider,
            hadSessionId: !!effectiveCtx.sessionId,
          });
          // KPR-353 (§D4): a provider handoff invalidates the thread's replay
          // history (validity is contiguous-same-provider by construction).
          // AWAITED — load-bearing: this very turn proceeds through
          // prepareSpawn to the adapter's load(), so only a clear that
          // resolves before the spawn continues orders the Mongo delete ahead
          // of the read; fire-and-forget would let the post-handoff turn
          // replay the stale doc. An awaited fail-soft Mongo op inside the R7
          // window is established posture (the sessionStore.get above), and
          // clear() never throws (§D3) — the catch is belt-and-braces for
          // foreign store impls/mocks. Accepted residual (spec §D4): if the
          // swallowed clear FAILS, the stale doc survives until TTL
          // (same-provider turns never re-trip the guard) — warn-logged in
          // the store, tolerated; a resulting 4xx lands in the §D7 self-heal.
          if (this.turnHistoryStore) {
            await this.turnHistoryStore.clear(ctx.agentId, ctx.threadId).catch(() => {});
          }
          effectiveCtx = { ...effectiveCtx, sessionId: undefined, sessionHandoff: true };
        }
      }

      if (!effectiveCtx.sessionId) this.recordSpawn(effectiveCtx.workItem.source.id);

      // KPR-224 + KPR-226: shape prompt + resolve model router once at the
      // spawnTurn level so both the happy-path call and any auth-rebuild
      // retry use the same shaped values, and recordSpawnObservability sees
      // the shaped prompt/effort in scope. Kept INSIDE the HOF lambda so any
      // throw in shaping (e.g., formatFilesForPrompt on malformed file
      // metadata) cannot leak the per-thread lock or budget slot — KPR-226
      // regression prevention.
      const shaping = await this.prepareSpawn(effectiveCtx);

      // KPR-306: exactly one breaker record per spawnTurn, on the FINALIZED
      // attempt. The auth-rebuild first attempt is locally recoverable —
      // when the retry fires, only the retry's result reaches the breaker
      // (record-once falls out of recording whichever result becomes the
      // turn result). Thrown adapter errors (rare pre-request throws, e.g.
      // codex missing OAuth) classify via classifyThrown and rethrow.
      // AgentStoppedError never originates inside this try (stop checkpoints
      // live in withSpawnTicket), and ProviderCircuitOpenError cannot reach
      // it (acquire threw before a permit existed) — the guard is
      // belt-and-braces for future refactors.
      let finalResult: RunResult;
      try {
        finalResult = await this.runOneSpawnAttempt(effectiveCtx, shaping, ticket, onStream);
        if (finalResult.error && isAuthRebuildResumeError(finalResult.error) && effectiveCtx.sessionId) {
          log.warn("spawnTurn auth-rebuild-resume — retrying without resume", {
            agentId: effectiveCtx.agentId,
            threadId: effectiveCtx.threadId,
            reason: finalResult.error,
          });
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: undefined },
            shaping,
            ticket,
            onStream,
          );
        } else if (
          // KPR-350 (§D3): stale server-handle self-heal. The store held a
          // handle the server no longer honors (30d expiry edge, deletion,
          // org rotation) — without this arm the thread errors identically
          // every turn until the row TTLs out (up to 7 days). One fresh
          // retry; a successful retry overwrites the row via the normal
          // finalizeSpawnResult path (no explicit scrub — the write path
          // self-corrects); a failed retry surfaces normally and the
          // churn-mint rider keeps the stale handle for the next turn's
          // re-trip (bounded waste: one extra attempt per turn, never a dead
          // thread). SEMANTICS gate, not provider gate — the KPR-347 seam:
          // dead for client-transcript (their resume errors mean other
          // things) and stateless-replay (no handle exists to be stale).
          // `else if` ⇒ at most one retry per turn, and record-once is
          // untouched: only the finalized attempt reaches the breaker.
          finalResult.error &&
          isStaleServerHandleError(finalResult.error) &&
          effectiveCtx.sessionId &&
          sessionSemanticsFor(shaping.route.provider) === "server-resumable"
        ) {
          // Deliberately NOT logging the error string: the provider's stale-
          // handle message embeds the resp_ handle value (log-redaction
          // posture — spec §D3 "no handle value").
          log.warn("spawnTurn stale-server-handle — retrying without resume (KPR-350)", {
            agentId: effectiveCtx.agentId,
            threadId: effectiveCtx.threadId,
            provider: shaping.route.provider,
          });
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: undefined },
            shaping,
            ticket,
            onStream,
          );
        }
      } catch (err) {
        if (!(err instanceof AgentStoppedError)) {
          this.circuitBreakers.record(permit, classifyThrown(err), 0);
        }
        throw err;
      }
      this.circuitBreakers.record(permit, classifyTurnResult(finalResult), finalResult.llmMs);

      const turnResult = this.finalizeSpawnResult(effectiveCtx, finalResult, shaping.route);
      this.recordSpawnObservability(effectiveCtx, shaping, finalResult);

      // KPR-220 Phase 6: post-quiescence reflection scheduling. Reflection
      // turns themselves don't reschedule (kind="reflection" guard).
      if (effectiveCtx.kind !== "reflection") {
        this.scheduleReflectionIfEligible(effectiveCtx, turnResult);
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
      this.recordSaturation(ctx.agentId, active, budget);
      throw new Error(
        `Spawn budget exceeded for ${ctx.agentId} (${active}/${budget})`,
      );
    }
    this.activeSpawnCount.set(ctx.agentId, active + 1);
    this.lastSpawnAt.set(ctx.agentId, Date.now());

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

    // KPR-220 Phase 15: cancel any pending reflection timer for this thread —
    // a new user turn breaks the "30s quiescent" invariant. Skipped for
    // reflection turns themselves (which would otherwise self-cancel).
    if (ctx.kind !== "reflection") {
      this.cancelReflectionTimer(ctx.agentId, ctx.threadId);
    }

    // Post-lock stop check: closes the race where stopAgent fires between
    // lock acquisition and fn invocation.
    if (this.stoppedAgents.has(ctx.agentId)) {
      ticketSet.delete(ticket);
      // Identity-check before deleting the map entry: a concurrent
      // stopAgent + restartAgent + new spawn could have replaced the
      // map entry with a fresh Set holding the new turn's ticket. We
      // must only clean up our own entry, not someone else's.
      if (ticketSet.size === 0 && this.activeTickets.get(ctx.agentId) === ticketSet) {
        this.activeTickets.delete(ctx.agentId);
      }
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
      // Identity-check (see post-lock cleanup above for rationale).
      if (ticketSet.size === 0 && this.activeTickets.get(ctx.agentId) === ticketSet) {
        this.activeTickets.delete(ctx.agentId);
      }
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
   * KPR-220 Phase 11: returns which fallback fired for an agent's budget.
   * Mirrors `spawnBudgetFor`'s chain so the snapshot can surface the source
   * (helpful when an operator wants to know whether to set `spawnBudget` on
   * the agent definition vs. relying on legacy `maxConcurrent`).
   */
  private spawnBudgetSource(agentId: string): "spawnBudget" | "maxConcurrent" | "default" {
    const def = this.registry.get(agentId);
    if (def?.spawnBudget !== undefined) return "spawnBudget";
    if (def?.maxConcurrent !== undefined) return "maxConcurrent";
    return "default";
  }

  /**
   * KPR-220 Phase 11: invoked by `withSpawnTicket` when the per-agent budget
   * blocks a spawn. Increments saturation count + timestamp for the snapshot;
   * also logs warn so the operator sees the saturation event live.
   */
  private recordSaturation(agentId: string, active: number, budget: number): void {
    const prev = this.saturationEvents.get(agentId) ?? { count: 0, lastAt: 0 };
    const next = { count: prev.count + 1, lastAt: Date.now() };
    this.saturationEvents.set(agentId, next);
    log.warn("Spawn budget saturated", { agentId, active, budget, saturationCount: next.count });
  }

  /**
   * KPR-220 Phase 11 / spec S6: read-only snapshot of the spawn coordinator.
   * Iterates the union of agents-with-state and agents-with-tickets so an
   * agent that was spawned-then-stopped still appears in the snapshot until
   * its zombie state is swept.
   */
  getSnapshot(): CoordinatorSnapshot {
    const perAgent: Record<string, CoordinatorSnapshotPerAgent> = {};
    // KPR-220 Phase 16: include every registered agent — even ones that
    // haven't handled traffic yet — so the heartbeat writes meaningful
    // per-agent rows on a fresh engine. Without this, `hive doctor`
    // reports "no heartbeat yet" until the first turn lands.
    const agentIds = new Set<string>([
      ...this.registry.listIds(),
      ...this.states.keys(),
      ...this.activeTickets.keys(),
      ...this.saturationEvents.keys(),
    ]);

    for (const agentId of agentIds) {
      const tickets = this.activeTickets.get(agentId);
      const activeSpawns = tickets?.size ?? 0;
      const prefix = `${agentId}:`;
      const activeThreadKeys: string[] = [];
      for (const key of this.activeSpawnKeys) {
        if (key.startsWith(prefix)) activeThreadKeys.push(key);
      }
      const sat = this.saturationEvents.get(agentId);
      perAgent[agentId] = {
        activeSpawns,
        activeThreadKeys,
        budget: this.spawnBudgetFor(agentId),
        budgetSource: this.spawnBudgetSource(agentId),
        saturationCount: sat?.count ?? 0,
        lastSaturationAt: sat?.lastAt ?? null,
        lastSpawnAt: this.lastSpawnAt.get(agentId) ?? null,
        lastError: this.lastSpawnError.get(agentId) ?? null,
        stopped: this.stoppedAgents.has(agentId),
      };
    }

    return { perAgent };
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

    // KPR-220 Phase 15: quiescence pre-check. If the thread has an active
    // spawn right now (a user turn that started within the debounce window
    // but should have cancelled the timer in withSpawnTicket — if we got
    // here anyway it means the timer fired in the microsecond window
    // between turn-arrival and lock-acquisition), abort without rescheduling.
    // The user turn's completion will reschedule via
    // scheduleReflectionIfEligible. Without this, runReflectionTurn would
    // queue behind the user turn and violate the "thread quiescent" invariant.
    const threadKey = `${agentId}:${threadId}`;
    if (this.processing.has(threadKey)) {
      log.debug("Reflection skipped — thread not quiescent", { agentId, threadId });
      return;
    }

    // Note: sessionId is resolved AGAIN inside spawnTurn AFTER the per-thread
    // lock is acquired (see spawnTurn's effectiveCtx logic for ctx.kind ===
    // "reflection"). The capture here is best-effort for any pre-lock logic
    // that needs it; the post-lock re-resolve is the authoritative read.
    const stored = await this.sessionStore.get(agentId, threadId);
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
      sessionId: stored?.sessionId,
      sessionProvider: stored?.provider,
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

  /**
   * KPR-220 Phase 15: cancel the pending reflection timer for a single
   * (agentId, threadId) pair. Called from `withSpawnTicket` when a non-
   * reflection turn starts on that thread, breaking the "30s quiescent"
   * invariant. The reflection state itself (pendingReflectionTurns,
   * lastSender, etc.) stays intact so the next eligible turn completion
   * picks up where the timer left off.
   */
  private cancelReflectionTimer(agentId: string, threadId: string): void {
    const key = this.reflectionKey(agentId, threadId);
    const state = this.reflectionStates.get(key);
    if (state?.timer) {
      clearTimeout(state.timer);
      state.timer = null;
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
    shaping: SpawnShaping,
    ticket: SpawnTicket,
    onStream?: SpawnTurnStreamCallback,
  ): Promise<RunResult> {
    // KPR-347: built BEFORE adapter construction so Lane B assembly receives
    // the turn's WorkItemContext (context-sensitive server configs).
    const bgContext: WorkItemContext = {
      adapterId: ctx.workItem.source.adapterId ?? ctx.workItem.source.kind,
      channelId: ctx.channelId,
      channelKind: ctx.workItem.source.kind,
      channelLabel: ctx.workItem.source.label,
      threadId: ctx.threadId,
      slackTs: (ctx.workItem.meta?.slackTs as string) ?? "",
      slackThreadTs: (ctx.workItem.meta?.slackThreadTs as string) ?? "",
    };

    // Fresh provider adapter per spawn — its lazy-built in-process MCPs are therefore
    // also fresh, with channel/thread ctx captured at construction. The
    // long-lived path keeps reusing one runner per agent.
    //
    // KPR-347 abort-window closure (§D5): construction is now async; an
    // abort landing while assembly is in flight must not become a lost
    // no-op (abortHandle unset). Flag early, re-attach after construction,
    // re-check. Aborted results stay breaker-neutral (classifyTurnResult).
    let abortedEarly = false;
    ticket.attachAbort(() => {
      abortedEarly = true;
    });
    const adapter = await this.createProviderAdapter(ctx.agentId, shaping.route, bgContext);
    ticket.attachAbort(() => adapter.abort());

    // KPR-347 §D5: an abort that landed while the async assembly above was in
    // flight must not run the full turn. A flag-only re-check on the adapter
    // cannot close the window — all three pilot adapters reset `aborted` at
    // runTurn() entry and ClaudeAgentAdapter's abort is a pre-send no-op — so
    // the skip is manager-owned and provider-agnostic: bypass runTurn()
    // entirely and synthesize a breaker-neutral aborted RunResult. adapter.abort()
    // still fires to signal any adapter holding state (harmless). The result is
    // a normal aborted completion (classifyTurnResult → "aborted"), NOT a thrown
    // error, so the KPR-306 recorded-try classification stays neutral.
    if (abortedEarly) {
      adapter.abort();
      const aborted = this.synthesizeAbortedResult(ctx.sessionId ?? "");
      aborted.costUsd += shaping.routerCostUsd;
      return aborted;
    }

    const result = await adapter.runTurn({
      prompt: shaping.prompt,
      sessionId: ctx.sessionId,
      onStream,
      workItemContext: bgContext,
      resourceLimits: shaping.resourceLimits,
      systemPromptOverride: ctx.systemPromptOverride,
      effort: shaping.effortOverride,
    });
    // KPR-224: model router cost lives outside RunResult; add it here so
    // finalizeSpawnResult and recordSpawnObservability see the full cost.
    result.costUsd += shaping.routerCostUsd;
    return result;
  }

  /**
   * KPR-347 §D5: minimal breaker-neutral aborted RunResult for the early-abort
   * skip in runOneSpawnAttempt (no runTurn() call was made). Mirrors the pilot
   * adapters' buildResult zero-shape (all counters 0, toolSummary "none") with
   * `aborted: true` so classifyTurnResult resolves to "aborted" and the
   * downstream finalize path (session persist skipped on aborted, telemetry
   * skipped) behaves exactly as a real adapter-emitted abort. sessionId is the
   * resumed handle (if any) so finalizeSpawnResult's newSessionId stays intact.
   */
  private synthesizeAbortedResult(sessionId: string): RunResult {
    return {
      text: "",
      sessionId,
      costUsd: 0,
      durationMs: 0,
      llmMs: 0,
      toolMs: 0,
      toolCalls: 0,
      toolSummary: "none",
      streamed: false,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 0,
      compactions: 0,
      aborted: true,
    };
  }

  /**
   * KPR-346 (§D6): Lane A :effort delivery. The runner's existing narrowing
   * (agent-runner.ts — only {low,medium,high} reach SDK Options.effort) is
   * the deliverable set; clamping HERE (with a warn) makes the drop explicit
   * at the shaping seam instead of silently swallowed by the runner.
   * Whether the foreign endpoint honors, ignores, or rejects the param is
   * validation item V4 (Task 5).
   */
  private clampLaneAEffort(
    agentId: string,
    model: string,
    effort: CodexReasoningEffort | undefined,
  ): ReasoningEffort | undefined {
    if (!effort) return undefined;
    if (effort === "low" || effort === "medium" || effort === "high") return effort;
    const key = `${agentId}:${model}`;
    if (!this.laneAEffortClampWarned.has(key)) {
      this.laneAEffortClampWarned.add(key);
      log.warn("Lane A :effort suffix outside the deliverable {low,medium,high} set — dropped", {
        agentId,
        model,
        effort,
      });
    }
    return undefined;
  }

  /**
   * KPR-224 + KPR-311: per-turn shaping for `spawnTurn` (its single caller
   * post-KPR-220). Centralizes:
   *  - sender identity prepending (`[user:X via Y in #Z]:` for team /
   *    `[Y in #Z, thread=ts]:` for slack-with-sender)
   *  - file-attachment text appending
   *  - static per-turn route (KPR-338): the route is ALWAYS the agent's
   *    static resolveProviderModel(agent.model) — the router no longer
   *    merges a per-turn model decision (kpr-338-spec §1.3). The classifier
   *    contributes reasoning effort only. The router still runs only for
   *    Claude-static agents (pilot gate — pilots are constructor-baked).
   *
   * Voice carve-out: voice has its own `systemPromptOverride` injection
   * (KPR-219) and explicitly bypasses prepending + model router. Returns
   * raw text + the static route for `ctx.channel === "voice"`.
   */
  private async prepareSpawn(ctx: TurnContext): Promise<SpawnShaping> {
    const item = ctx.workItem;

    // Static route — resolved ONCE per turn, here; createProviderAdapter
    // consumes it (KPR-311). The `?.model ?? ""` guard mirrors the breaker
    // acquire site (KPR-306): SIGUSR1 hot-reload can remove the agent
    // between spawnTurn's registry pre-check and this point, and an
    // unguarded dereference would throw OUTSIDE the recorded try — skipping
    // the breaker's record() and wedging a half-open probe permit for up to
    // PROBE_STALE_MS. The degenerate route ({provider:"claude", model:""})
    // flows on instead; the turn then fails INSIDE the recorded try via
    // createProviderAdapter's `Unknown agent` throw (classifyThrown →
    // non-provider → never trips).
    const agentConfig = this.registry.get(ctx.agentId);
    const staticRoute = resolveProviderModel(agentConfig?.model ?? "");
    // KPR-338: static tier — guarded like staticRoute (KPR-306 wedged-permit
    // hazard; see the comment above). Only meaningful on the claude-static
    // router-on path below.
    const staticTier = modelToTier(agentConfig?.model ?? "");

    // Voice carve-out: KPR-219 supplies its own systemPromptOverride and
    // explicitly bypasses prepending + model router. Pin via this branch so
    // future prepareSpawn edits cannot accidentally re-shape voice prompts.
    if (ctx.channel === "voice") {
      return { prompt: item.text, route: staticRoute, resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined };
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

    // KPR-313 §3.4: hive-owned handoff annotation — sessionHandoff is set
    // ONLY by spawnTurn's session-identity guard. Prepended ahead of the
    // sender prefix; memory carryover needs nothing here (every fresh spawn
    // already assembles the full system prompt incl. agent memory). Variant
    // keyed on the static provider (≡ effective under the W3 clamp): pilots
    // are tool-free, so only Claude targets get the conversation_search clause.
    if (ctx.sessionHandoff) {
      // KPR-346 (§D7): variant keys on CLAUDE-RUNTIME LANE MEMBERSHIP, not
      // === "claude" — Lane A agents run the full runtime and have
      // conversation_search. Future ids fail toward the tool-free pilot
      // variant (safe default).
      prompt =
        (staticRoute.provider === "claude" || isLaneAProvider(staticRoute.provider)
          ? SESSION_HANDOFF_NOTICE_CLAUDE
          : SESSION_HANDOFF_NOTICE_PILOT) + prompt;
    }

    // KPR-346 (§D6): Lane A — the router stays skipped (foreign ids are
    // off-catalog, supportsEffort false, KPR-322 rule stands; zero classifier
    // cost) but the static :effort suffix delivers through the Claude
    // adapter's existing channel. resourceLimits stays undefined — the
    // runner's per-agent legacy fallback applies; Claude static-tier limits
    // are never computed for foreign models.
    if (isLaneAProvider(staticRoute.provider)) {
      return {
        prompt,
        route: staticRoute,
        resourceLimits: undefined,
        routerCostUsd: 0,
        effortOverride: this.clampLaneAEffort(
          ctx.agentId,
          agentConfig?.model ?? "",
          "reasoningEffort" in staticRoute ? staticRoute.reasoningEffort : undefined,
        ),
      };
    }

    // Router gate (KPR-311): skip when disabled, for system senders
    // (scheduler/cron), when the agent vanished mid-turn (guard above), or
    // when the agent's static provider isn't Claude (pilot gate — calling
    // the router for a pilot charged routerCostUsd for an output the pilot
    // ignores and misattributed the Claude model in telemetry/audit — R-311.2).
    if (!agentConfig || !appConfig.modelRouter.enabled || item.sender === "system" || staticRoute.provider !== "claude") {
      return { prompt, route: staticRoute, resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined };
    }

    // KPR-338: the turn's model is ALWAYS agentConfig.model (fixed-tier
    // invariant, kpr-338-spec §1.3). Execution bounds derive from the agent's
    // STATIC tier — same path that carried router-derived limits before
    // (path-preserving), explicitly NOT effort-keyed.
    const staticLimits = resolveResourceLimits(staticTier, agentConfig.resourceTiers);

    // Haiku-skip (replaces router H1) + effort-capability gate (kpr-338-spec
    // §3.1 residual, plan D1/D2): when the static model cannot receive the
    // effort param, the classifier's only remaining output is undeliverable —
    // skip the call entirely (zero classifier cost/latency; today's
    // haiku-tier envelope preserved). supportsEffort is catalog-driven
    // (KPR-314); unknown ids are conservatively false — warn once so an
    // off-catalog operator model doesn't silently lose the effort lever.
    if (staticTier === "haiku" || !getLLMRegistry().supportsEffort(agentConfig.model)) {
      if (staticTier !== "haiku" && !this.effortIncapableWarned.has(agentConfig.model)) {
        this.effortIncapableWarned.add(agentConfig.model);
        log.warn(
          "Per-turn effort hints disabled — agent model is not effort-capable in the LLM catalog (off-catalog id?)",
          { agentId: ctx.agentId, model: agentConfig.model },
        );
      }
      return { prompt, route: staticRoute, resourceLimits: staticLimits, routerCostUsd: 0, effortOverride: undefined };
    }

    try {
      const result = await routeModel(item.text, {
        // H3 guard (KPR-312): file-bearing messages must not short-circuit on
        // empty text — file content is appended into `prompt` above and never
        // reaches the classifier.
        hasFiles: Boolean(item.files?.length),
      });
      // Effort rides BESIDE the route (R-312.3, byte-untouched channel):
      // SpawnShaping.effortOverride → AgentProviderTurnRequest.effort →
      // Options.effort. The classifier's tier/model outputs are no longer
      // read (deleted from the contract in the next commit).
      return { prompt, route: staticRoute, resourceLimits: staticLimits, routerCostUsd: result.costUsd, effortOverride: result.effort };
    } catch (err) {
      // Belt-and-braces (routeModel owns its own fallback and should not
      // throw). Degenerate shape preserved: resourceLimits stays undefined on
      // this path (KPR-338 path-preserving rule — runner legacy fallback).
      log.warn("Model router failed, using defaults", { agentId: ctx.agentId, error: String(err) });
      return { prompt, route: staticRoute, resourceLimits: undefined, routerCostUsd: 0, effortOverride: undefined };
    }
  }

  /**
   * KPR-224: post-spawn observability for `spawnTurn` (its single caller
   * post-KPR-220). Records turn telemetry (per-turn cache window),
   * conversation index (semantic recall), and activity audit. All three
   * fail-soft — telemetry/index/audit failures cannot cascade into the
   * turn pipeline.
   */
  private recordSpawnObservability(
    ctx: TurnContext,
    shaping: SpawnShaping,
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
          model: this.registry.get(ctx.agentId)?.model,
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
          inbound: shaping.prompt,
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
      model: this.registry.get(ctx.agentId)?.model ?? "unknown",
      // KPR-338 D4: tier is a static per-agent fact — audited on every
      // claude-static turn (R-311.7's observability feed, now static).
      // Pilots carry no tier: modelToTier is a Claude-id substring heuristic,
      // meaningless on provider-prefixed ids.
      modelTier: shaping.route.provider === "claude" ? modelToTier(shaping.route.model) : undefined,
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

  private finalizeSpawnResult(ctx: TurnContext, result: RunResult, route: ProviderModelRoute): TurnResult {
    const newSessionId = result.sessionId || ctx.sessionId || "";
    if (result.sessionId && !result.aborted) {
      // KPR-313 §3.2: persist a resumable handle ONLY for providers whose
      // adapters actually resume. Stateless pilots keep the ROW (the session
      // store doubles as the dispatcher's thread→agent map via
      // findAgentByThread) with an empty sessionId — the row persists, the
      // fake handle never does.
      const resumable = persistsResumableHandle(sessionSemanticsFor(route.provider));
      // ⚠A4 churn-mint rider: an ERROR turn that attempted a resume and came
      // back with a DIFFERENT id is a failed-resume mint (the CLI's
      // error_during_execution result carries a freshly minted session_id) —
      // never let it overwrite the row. Error turns may only re-persist the
      // SAME id they resumed (TTL refresh; harmless per M7b — ids are stable
      // and the prior value stays the right handle if the session exists at
      // all). Success-path compaction rotation (KPR-211) is unaffected: no
      // error ⇒ rider never fires.
      const churnMint = !!result.error && !!ctx.sessionId && result.sessionId !== ctx.sessionId;
      if (churnMint) {
        log.warn("Skipping session persist — errored turn returned a different id than it resumed (KPR-313)", {
          agentId: ctx.agentId,
          threadId: ctx.threadId,
        });
      } else {
        // Persist post-spawn — captures session-id rotation post-compaction
        // (KPR-211 verified this fires on resume).
        this.sessionStore.set(ctx.agentId, ctx.threadId, resumable ? result.sessionId : "", route.provider, {
          inputTokens: result.inputTokens,
          outputTokens: result.outputTokens,
          cacheReadTokens: result.cacheReadTokens,
          cacheCreationTokens: result.cacheCreationTokens,
          contextWindow: result.contextWindow,
          compactions: result.compactions,
          preCompactTokens: result.preCompactTokens,
        });
      }
    }

    const state = this.states.get(ctx.agentId)!;
    state.messagesProcessed++;
    state.lastActivity = new Date();
    state.currentSessionId = result.sessionId;
    if (result.error) {
      state.errorCount++;
      // KPR-220 Phase 11: surface the most-recent error in the snapshot
      // (truncated to 240 chars to keep the heartbeat doc bounded).
      this.lastSpawnError.set(ctx.agentId, result.error.slice(0, 240));
    }

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
      timedOut: result.timedOut,
      aborted: result.aborted,
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
    //
    // Phase 13 (post-review): do NOT delete activeTickets[agentId] here.
    // Each in-flight ticket's withSpawnTicket finally cleans up its own
    // entry. If we wipe the map here, a fast restartAgent + new spawn
    // can register a fresh Set under the same key — and the old aborted
    // turn's finally (firing later) would then erase the new Set. The
    // finally's identity-check now also defends against any other
    // future caller making the same mistake.
    this.stoppedAgents.add(agentId);
    this.cancelReflectionsFor(agentId);
    const tickets = this.activeTickets.get(agentId);
    if (tickets) {
      for (const ticket of tickets) {
        ticket.abort();
      }
    }
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
