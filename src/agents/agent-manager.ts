import { createLogger } from "../logging/logger.js";
import type { AgentConfig, AgentState, AgentStatus } from "../types/agent-config.js";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import { AgentRunner, DIST_DIR, type AgentRunnerOptions, type RunResult, type StreamCallback, type WorkItemContext } from "./agent-runner.js";
import type { MeetingWorkerPool } from "../workers/meeting-worker-pool.js";
import { AgentRegistry } from "./agent-registry.js";
import { detectIntentTrailer } from "./intent-trailer.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { SessionStore } from "./session-store.js";
import type { TurnHistoryStore } from "./turn-history-store.js";
import type { TurnTelemetryStore } from "./turn-telemetry.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import type { Db } from "mongodb";
import { formatFilesForPrompt } from "../files/file-processor.js";
import {
  routeModel,
  modelToTier,
  resolveResourceLimits,
  type ResourceLimits,
  type ModelTier,
} from "./model-router.js";
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
import type { CodexReasoningEffort } from "./provider-adapters/codex-subscription-adapter.js";
import type { LaneBModuleDeps } from "./provider-adapters/provider-module.js";
import type { AgentProviderAdapter, ReasoningEffort, TurnEffort } from "./provider-adapters/types.js";
import { isAgentEffort, type AgentEffort, type EffortSource } from "./agent-effort.js";
import { persistsResumableHandle } from "./provider-adapters/types.js";
// KPR-394 (§4.3/§4.4): both Lane B construction sites resolve through the
// runtime provider registry — builtin seed + hive-plugin-add-loaded
// modules — via one shared lookup (getRegisteredProvider), so the two
// sites still cannot drift (KPR-391 §4.3 property preserved).
import {
  activateDeclaredProviders,
  declarePluginProviders,
  describeUnroutableProvider,
  getRegisteredProvider,
  isPluginDeclaredProvider,
  sessionSemanticsForRoute,
  warnOrphanProviderPrefixes,
  type RegisteredProvider,
} from "./provider-adapters/provider-registry.js";
import {
  assembleProviderTurn,
  buildNestedDelegateAssembly,
  type DelegateTurnRunner,
  type ProviderTurnAssembly,
} from "./provider-adapters/turn-assembly.js";
import {
  isLaneAProvider,
  resolvePassthroughSpawn,
  assertSafeBaseUrlOverride,
  resolveEnvKeyCredential,
  type PassthroughSpawnConfig,
} from "./provider-adapters/passthrough-providers.js";
import { resolveOAuthFileToken } from "./provider-adapters/grok-oauth.js";
import { ProviderCircuitBreakerRegistry } from "./provider-circuit-breaker.js";
import {
  classifyThrown,
  classifyTurnResult,
  hasObservedProgress,
  isClaudeResumeLoadError,
  TurnAssemblyError,
  TURN_DEADLINE_SUBTYPE,
} from "./provider-adapters/error-classification.js";

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
  // R2 (KPR-394): widened from AgentProviderId — StoredSessionRef.provider is
  // now a string (plugin provider ids are arbitrary registered strings).
  sessionProvider?: string;
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
  /** KPR-389: conference turn kind — 0 primary, 1 peer reaction. Set by
   *  runWorkItemTurn from WorkItem meta; undefined for every non-conference
   *  turn and for voice/reflection contexts (which never carry the meta). */
  conferenceRound?: 0 | 1;
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
  /**
   * KPR-388: true iff the FINALIZED attempt was launched with a session
   * handle (options.resume / previous_response_id / previous_interaction_id).
   * False when the finalized attempt ran fresh — first turn, KPR-313
   * provider handoff, auth-rebuild retry, KPR-350 stale-handle self-heal
   * fresh retry, KPR-399 claude resume-rejection fresh retry. KPR-351
   * contender adoption counts as resumed. Known approximation (spec ⚠): for
   * client-transcript lanes, "launched with a handle" is not proof the
   * transcript was warm — accepted, failure mode is bounded duplication or
   * one system-notice'd fresh turn.
   */
  resumedSession?: boolean;
}

/** Mirrors AgentRunner.send()'s StreamCallback so adapter-side relay code stays the same. */
export type SpawnTurnStreamCallback = StreamCallback;

/** KPR-389: typed read of the dispatcher's conference discriminator (C3 —
 *  meta.conferenceRound is the round-1 discriminator). Returns undefined for
 *  non-conference items and malformed values. Exported — the dispatcher's
 *  D5b single-dispatch suppression leg reads it too. */
export function conferenceRoundOf(item: WorkItem): 0 | 1 | undefined {
  const v = item.meta?.conferenceRound;
  return v === 0 || v === 1 ? v : undefined;
}

/** KPR-389: typed read of the KPR-388 injection mode stamped beside the round. */
function conferenceInjectionModeOf(item: WorkItem): "full" | "delta" | "summary" | undefined {
  const v = item.meta?.conferenceInjectionMode;
  return v === "full" || v === "delta" || v === "summary" ? v : undefined;
}

/**
 * Default per-agent in-flight spawn budget. Long-lived `maxConcurrent`
 * defaults to 3 (per-thread); per-turn spawns count differently — same
 * thread is still serialized, so the budget bounds parallel spawns across
 * different threads. Plan §D3: "spawn budget calibration becomes a more
 * open-ended dial." Tunable per-agent in a future ticket.
 */
const DEFAULT_PER_AGENT_SPAWN_BUDGET = 5;

/**
 * KPR-394 (§4.3, R2): flattened from a closed literal union to a generic
 * shape — `provider` is any routable provider string (built-in arms below
 * plus plugin-declared ids from the registry). Construction literals are
 * byte-identical to the pre-394 arms; in-tree `route.provider === "..."`
 * comparisons still narrow. KPR-392/KPR-346 semantics unchanged.
 */
interface ProviderModelRoute {
  provider: string;
  model: string;
  reasoningEffort?: CodexReasoningEffort;
}

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
  if (provider === "grok") {
    return { provider: "grok", model: providerModel, reasoningEffort };
  }

  // KPR-394 (§4.3): a DECLARED plugin provider id (registered, still
  // loading, or declared-broken) routes to ITSELF — the honest-failure path
  // lives at adapter construction, never a silent Claude fallback. Only
  // never-declared prefixes fall through to the Claude canon below.
  // Registry state is module-global (this function is module-scope and is
  // also consumed statically by providerFor and prepareSpawn).
  if (isPluginDeclaredProvider(provider)) {
    return { provider, model: providerModel, reasoningEffort };
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
   * static :effort suffix — §D6). KPR-430: ALSO set by the static agent
   * `effort` field (claude lane, every non-voice, non-round-1 path; Lane A
   * through the clamp) — precedence pin > static > router.
   */
  effortOverride: TurnEffort | undefined;
  /**
   * KPR-430 D6: provenance of effortOverride for telemetry. Optional —
   * set ONLY where effortOverride is set (the telemetry stamp additionally
   * nests it inside the effort spread, so a source can never land alone).
   */
  effortSource?: EffortSource;
  /** Execution bounds. Claude lane: static-tier bounds, set ONLY on the
   *  router-on path (KPR-338 path-preserving rule) — undefined elsewhere so
   *  the runner's per-agent legacy fallback (timeoutMs/maxTurns/budgetUsd)
   *  stays live config. ALSO set by prepareSpawn's Lane B branch
   *  (openai/gemini/codex), from the agent definition — those adapters have
   *  no runner-side fallback and consume maxTurns (round budget) and
   *  timeoutMs (wall-clock deadline); budgetUsd stays inert there. Voice and
   *  Lane A stay undefined. */
  resourceLimits: ResourceLimits | undefined;
  routerCostUsd: number;
}

/**
 * KPR-313 §3.4: hive-owned handoff annotation, prepended by prepareSpawn
 * when spawnTurn's session-identity guard reset thread continuity. Binding
 * content requirements (spec): the engine changed, prior turns in this
 * thread are not in context, agent memory is intact. The conversation_search
 * recall clause is Claude-target only — the Lane B variant is the
 * conservative pilot-era default (KPR-347 deleted the assertToolFreePilot
 * guards), kept as-is pending a dedicated follow-up even though KPR-348
 * gave all three Lane B adapters real tool execution, so the pilot variant
 * must not suggest a tool the agent cannot reach. Voice never sees either
 * (carve-out returns first; voice's handoff is its full-transcript re-send).
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

/** KPR-389: turn-scoped reaction caps. Template: KPR-354's nested-delegate
 *  literal override (resourceLimits: { maxTurns, timeoutMs: 600_000,
 *  budgetUsd: 0 }); here we clamp with min() instead of replacing so tighter
 *  operator config always wins. maxTurns 6 < KPR-354's 7/10 delegate budgets
 *  (a reaction is strictly lighter); 120s reuses the haiku-tier light-turn
 *  precedent. Plain constants — tune when the D6 telemetry says otherwise. */
const REACTION_MAX_TURNS = 6;
const REACTION_TIMEOUT_MS = 120_000;

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
  /** KPR-430: once-per-(agent,model) warn when a static `effort` field is
   *  set but the Claude-lane model cannot receive the param (haiku tier or
   *  off-catalog — the KPR-338 deliverability gate). */
  private readonly staticEffortDroppedWarned = new Set<string>();
  /** KPR-430: once-per-(agent,model) warn when a static `effort` field is
   *  set on a Lane B agent, where request.effort is ignored by contract. */
  private readonly laneBEffortFieldWarned = new Set<string>();
  /**
   * KPR-306: per-provider circuit breakers. Read-only surface — KPR-307's
   * dispatcher-side consumer and the CircuitBreakerHeartbeat both reach it
   * via the AgentManager instance (no new wiring surface).
   */
  readonly circuitBreakers: ProviderCircuitBreakerRegistry;
  /** KPR-390: meeting worker pool — wired post-dispatcher by index.ts. */
  private workerPool?: MeetingWorkerPool;

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
    // KPR-394 (§4.3 phase a): synchronous declaration — every declared
    // provider id is honest-failure-routable from the first instant.
    // Phase (b) activation is async and awaited by index.ts via
    // activateProviderPlugins() before any spawn-capable surface starts.
    declarePluginProviders(this.plugins, { hiveHome, distDir: DIST_DIR });
    this.seedDirs = discoverSeedDirs(seedsDir);
    this.skillIndex = loadSkillIndex(skillsDir, this.plugins, this.seedDirs, this.registry.listIds());
  }

  /**
   * KPR-390: wire the meeting worker pool (index.ts, post-dispatcher).
   * The handshake keeps runner-construction inputs inside the manager —
   * the pool holds only capabilities (spec §A3 "factory callback" choice).
   * The factory deliberately passes NO prefixCache (worker turns provably
   * can't touch the boss's cached prefix), NO workerPool (a worker can
   * never see worker-pool tools even if a config clone slipped the
   * denylist — belt-and-braces recursion guard), and sets
   * suppressAutoInjectedServers — WITHOUT which the runner re-adds
   * team/schedule/team-roster unconditionally and the denylist strip in
   * runWorkerTurn is a no-op (through-the-boss would be fiction).
   */
  setWorkerPool(pool: MeetingWorkerPool): void {
    this.workerPool = pool;
    pool.bindManager({
      buildWorkerAdapter: (workerConfig) => {
        const eventSubscribersJson = JSON.stringify(this.registry.getSubscriberMap());
        const runner = new AgentRunner(
          workerConfig,
          this.memoryManager,
          this.plugins,
          this.skillIndex,
          eventSubscribersJson,
          this.prefetcher,
          this.teamRoster,
          this.db,
          undefined, // prefixCache — deliberately absent
          this.memoryLifecycle,
          { suppressAutoInjectedServers: true }, // worker mode — no workerPool
        );
        return new ClaudeAgentAdapter(runner);
      },
      breakerStateFor: (provider) => this.circuitBreakers.stateFor(provider),
    });
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
   * KPR-394 (§4.3 phase b / §4.6): dynamic-import + factory-activate every
   * declared provider plugin. index.ts MUST await this immediately after
   * construction, BEFORE bgTaskManager.start()/scanOrphans() — their
   * completion callbacks can already dispatch turns. Boot-only; SIGUSR1
   * never loads or unloads provider code.
   */
  async activateProviderPlugins(): Promise<void> {
    await activateDeclaredProviders();
    this.warnOrphanProviderPrefixes();
  }

  /** KPR-394 (§4.6): orphan-model-prefix warn — boot + SIGUSR1 reload. */
  warnOrphanProviderPrefixes(): void {
    warnOrphanProviderPrefixes(this.registry.getAll().map((a) => ({ agentId: a.id, model: a.model })));
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

    // KPR-390: the pool rides along on every normal runner so a boss agent
    // with "worker-pool" in coreServers gets the in-process server; absent
    // pool ⇒ the runner never builds it (Day-1-OOB layer 2).
    const runnerOptions: AgentRunnerOptions | undefined =
      laneAPassthrough || this.workerPool
        ? { laneAPassthrough, workerPool: this.workerPool }
        : undefined;
    const runner = new AgentRunner(config, this.memoryManager, this.plugins, this.skillIndex, eventSubscribersJson, this.prefetcher, this.teamRoster, this.db, this.prefixCache, this.memoryLifecycle, runnerOptions);
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

    // KPR-394 (§4.3/§4.4): registry lookup — the same shared path the nested
    // delegate runner below resolves through. A declared-broken or
    // still-declared id throws the honest breaker-invisible
    // TurnAssemblyError here, inside runOneSpawnAttempt's recorded try
    // (classifyThrown → non-provider: config faults never trip a breaker or
    // open an outage episode).
    const registered = getRegisteredProvider(route.provider);
    if (!registered) {
      throw new TurnAssemblyError(describeUnroutableProvider(route.provider));
    }

    // KPR-391 (§4.3): named-handle deps for the provider modules — built
    // once, shared by the top-level tail and the nested delegate runner so
    // the two construction sites cannot drift.
    //
    // `providerConfig` is the ROUTE's own slice, resolved here — least
    // privilege at the construction seam. Both sites construct for
    // `route.provider` (the nested runner is a same-provider delegate turn),
    // so one slice serves both. Handing a module the full per-provider map
    // would hand every module every other provider's apiKey — harmless while
    // all four entries are in-tree; now that KPR-394 has landed and made
    // this contract the ABI for `hive plugin add`-loaded third-party
    // modules, resolveProviderModuleSlice below is what keeps it that way
    // (CLAUDE.md § Security (DOD-212)).
    // KPR-394: slice resolution generalized — see resolveProviderModuleSlice.
    const moduleDeps: LaneBModuleDeps = {
      providerConfig: await this.resolveProviderModuleSlice(registered),
      turnHistoryStore: this.turnHistoryStore,
      agentId: config.id,
    };

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
        const module = getRegisteredProvider(route.provider)?.module;
        if (!module) {
          // KPR-354 belt-and-braces containment, now also the registry-miss
          // path for any future gap (§4.4) — unreachable while construction
          // is boot-locked, kept as containment.
          return `Delegate turn failed (${call.delegate}): provider ${route.provider} does not execute tools`;
        }
        const nested: AgentProviderAdapter = module.createAdapter({
          name: `${config.name}:${call.delegate}`,
          route: { model: route.model, reasoningEffort: route.reasoningEffort },
          assembly: nestedAssembly,
          // G4: the codex module omits historyStore/agentId in nested context —
          // provider_turn_history is provably untouched by nested turns.
          // Gemini stays session-less by construction (§D6): no sessionId
          // flows into the nested runTurn below, the nested turn starts a
          // fresh chain, and the D5.7 shaping discards the final id — nothing
          // persists. Accepted residue: unreferenced store:true interactions
          // self-expire at vendor retention (55d paid) — KPR-350's 30d shape.
          context: "nested",
          deps: moduleDeps,
        });
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
          // maxTurns bounds the nested round budget; timeoutMs is a live
          // 10-minute wall-clock backstop on all three Lane B surfaces —
          // under default limits the PARENT's own deadline fires first and
          // abort-chains in via call.signal (nested deadline expiry surfaces
          // as Task tool text, breaker-invisible by construction). budgetUsd
          // stays inert on Lane B.
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
        // Map the deadline sentinel to prose — the raw subtype string would
        // be opaque to the parent model (reachable when an agent-def
        // timeoutMs above the nested 600s backstop lets the nested deadline
        // fire before the parent's).
        if (result.error === TURN_DEADLINE_SUBTYPE) {
          return `Delegate turn failed (${call.delegate}): the delegate exceeded its wall-clock deadline.`;
        }
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

    // KPR-394 (§4.4): same registry entry as the nested runner above —
    // model default chains, primary-only history wiring, and key threading
    // all live in the module entries (builtin or plugin).
    return registered.module.createAdapter({
      name: config.name,
      route: { model: route.model, reasoningEffort: route.reasoningEffort },
      assembly,
      context: "primary",
      deps: moduleDeps,
    });
  }

  /**
   * KPR-394 (§4.4): generalized caller-resolved module slice (C7/C15 —
   * engine resolves, module consumes opaquely; a module is never handed a
   * sibling's credential). Built-in arms preserve KPR-391/392 behavior
   * byte-for-byte. Plugin arms resolve the manifest-named keys PER SPAWN:
   * api-key-env on the exact secret-env chain (env → Honeypot; missing ⇒
   * breaker-invisible TurnAssemblyError naming `hive credentials add
   * <KEY>` — rotation takes effect next spawn); base-url-env as plain env
   * validated https-or-loopback (KPR-384 posture: an override redirects
   * credential AND conversation stream). Unset base-url-env ⇒ undefined ⇒
   * the module's own built-in default endpoint (a KPR-394 plugin's
   * base-url-env semantics, generalized).
   */
  private async resolveProviderModuleSlice(
    registered: RegisteredProvider,
  ): Promise<{ agentModel?: string; apiKey?: string; baseUrl?: string }> {
    if (registered.source !== "builtin") {
      const slice = registered.slice;
      const baseUrlOverride = slice?.baseUrlEnv ? process.env[slice.baseUrlEnv] : undefined;
      return {
        agentModel: slice?.defaultModel,
        apiKey: slice?.apiKeyEnv
          ? resolveEnvKeyCredential(slice.apiKeyEnv, { instanceId: appConfig.instance.id })
          : undefined,
        baseUrl:
          baseUrlOverride && slice?.baseUrlEnv
            ? assertSafeBaseUrlOverride(baseUrlOverride, slice.baseUrlEnv)
            : undefined,
      };
    }
    switch (registered.id) {
      case "gemini":
        return { agentModel: appConfig.gemini.agentModel, apiKey: appConfig.gemini.apiKey || undefined };
      case "grok":
        return this.resolveGrokModuleSlice();
      case "codex":
        return { agentModel: appConfig.codex.agentModel };
      case "openai":
        return { agentModel: appConfig.openai.agentModel };
      default:
        // Unreachable: the builtin seed is exactly the four Lane B ids.
        return {};
    }
  }

  /**
   * KPR-410: grok's caller-resolved module slice — the engine resolves, the
   * module consumes (DOD-212; load-bearing for KPR-394). The credential is
   * the machine's `grok login` subscription OAuth access token, resolved
   * (and refreshed + written back, if near expiry) from
   * `~/.grok/auth.json` by grok-oauth.ts — revived KPR-371 machinery,
   * byte-identical to the version KPR-384 deleted when it introduced the
   * now-retired gateway. No baseUrl slot: the adapter's endpoint is fixed at
   * https://api.x.ai, there is no override. This turns resolveGrokModuleSlice
   * async (file read, and near expiry — up to two network round-trips on a
   * cold discovery cache, one thereafter; each capped by grok-oauth.ts's own
   * 10s fetch timeout), which is why resolveProviderModuleSlice above is now
   * async too. This runs while createProviderAdapter builds moduleDeps —
   * after the breaker permit is acquired, but BEFORE the adapter is
   * constructed and before runTurn arms `timeoutMs`, so it sits outside the
   * turn deadline and can't be interrupted by abort(). Not the same
   * placement as codex's/openai's own credential resolution, which runs
   * inside executeTurn and so genuinely is deadline-bound. This work's own
   * bound is grok-oauth.ts's 10s fetch timeout, not the turn deadline —
   * separately, a half-open PROBE permit (not an ordinary closed-circuit
   * one) carries its own staleness bound (deadlineMs + 60s grace, KPR-400),
   * but that bounds how long the breaker waits on the permit, not how long
   * this credential resolution itself may run.
   */
  private async resolveGrokModuleSlice(): Promise<{ agentModel?: string; apiKey?: string }> {
    return {
      agentModel: appConfig.grok.agentModel,
      apiKey: await resolveOAuthFileToken("~/.grok/auth.json"),
    };
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
      conferenceRound: conferenceRoundOf(item),
    };

    return this.spawnTurn(ctx, onStream);
  }

  /**
   * KPR-307: the provider an agent's turns route to — additive read-only
   * surface for the dispatcher's post-turn outage gate. One-liner over the
   * same resolveProviderModel the KPR-306 wrap point uses, so dispatcher and
   * breaker always agree on the provider key.
   */
  providerFor(agentId: string): string | null {
    const agentConfig = this.registry.get(agentId);
    if (!agentConfig) return null;
    return resolveProviderModel(agentConfig.model).provider;
  }

  /**
   * KPR-400 (F1): acquire-time UPPER BOUND on the turn's effective wall
   * clock, threaded into the breaker as probe-staleness meta. The runner's
   * effective deadline is `resourceLimits?.timeoutMs ?? agentConfig.timeoutMs
   * ?? 300_000` (agent-runner.ts), and resourceLimits presence depends on
   * the router gate — unknowable exactly before prepareSpawn runs. So:
   * max(agent timeoutMs, claude static-tier limit). Over-estimating only
   * delays reconciliation of a structurally-prevented lost-permit case;
   * under-estimating is the live bug (a legitimate long probe stale-killed
   * mid-flight — kpr-400-spec R2, ⚠A3). Non-claude routes never get Claude
   * tier limits: Lane B pins `agentConfig.timeoutMs ?? 300_000` exactly at
   * prepareSpawn, Lane A uses the runner's identical fallback.
   */
  // R2 (KPR-394): provider widened to string — plugin ids are arbitrary
  // registered strings; the `!== "claude"` check reads correctly either way.
  private acquireDeadlineMs(provider: string, agentConfig: AgentConfig | undefined): number {
    const configuredMs = agentConfig?.timeoutMs ?? 300_000;
    if (!agentConfig || provider !== "claude") return configuredMs;
    // KPR-422: the agent's top-level timeoutMs is deliberately NOT passed as
    // the third argument here — the max() below already folds it in, and
    // passing it could only LOWER tierLimitMs (top-level wins over the tier
    // default inside resolveResourceLimits), tightening a bound whose
    // documented posture is over-estimation. The turn's effective deadline is
    // always ≤ max(configured, override ?? tierDefault), so the bound stays a
    // true upper bound.
    const tierLimitMs = resolveResourceLimits(modelToTier(agentConfig.model), agentConfig.resourceTiers).timeoutMs;
    return Math.max(configuredMs, tierLimitMs);
  }

  /** KPR-403: D20 acquire-time upper bound, exposed for outage-doc stamping.
   *  The dispatcher stamps each outage-queue doc with this bound at enqueue
   *  (the seam that has registry access), so the store's recovery sweep can
   *  read a doc's replay-turn wall-clock ceiling from the doc itself — no
   *  registry dependency at recovery time. Unknown agents fall back to the
   *  300s default (the doc still recovers by its stamped bound even if the
   *  agent is later deleted — kpr-403-spec §Edge-4). */
  turnDeadlineUpperBoundMs(agentId: string): number {
    const agentConfig = this.registry.get(agentId);
    const provider = agentConfig ? resolveProviderModel(agentConfig.model).provider : "claude";
    return this.acquireDeadlineMs(provider, agentConfig);
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
      const acquireAgentConfig = this.registry.get(ctx.agentId);
      const route = resolveProviderModel(acquireAgentConfig?.model ?? "");
      const permit = this.circuitBreakers.acquire(route.provider, {
        agentId: ctx.agentId,
        threadId: ctx.threadId,
        // KPR-400 (F1): the probe turn's own deadline (upper bound) drives
        // the breaker's probe-staleness bound — see acquireDeadlineMs.
        deadlineMs: this.acquireDeadlineMs(route.provider, acquireAgentConfig),
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

      // KPR-388: sessionId actually passed to the FINALIZED runOneSpawnAttempt
      // call — reassigned at each retry arm below. !!finalAttemptSessionId
      // becomes TurnResult.resumedSession. Initialized AFTER the KPR-313
      // guard and prepareSpawn, so a handoff-stripped (or adopt-branch)
      // sessionId is what's captured.
      let finalAttemptSessionId = effectiveCtx.sessionId;

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
          finalAttemptSessionId = undefined;
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
          sessionSemanticsForRoute(shaping.route.provider) === "server-resumable"
        ) {
          // KPR-351 (R2): chain-orphan closure. Two same-thread turns can
          // both resolve the same stale handle PRE-lock; the first heals and
          // persists a fresh chain head; the queued second then trips this
          // arm and — without a re-read — would retry fresh, orphaning the
          // healed chain (one exchange lost, healed handle overwritten). One
          // post-lock sessionStore re-read (authoritative under the per-
          // thread lock — the KPR-313 adopt-branch's own idiom above) adopts
          // a contender's same-provider, non-empty, DIFFERENT handle; every
          // other shape falls through to the fresh retry exactly as KPR-350
          // shipped it. Single-retry semantics (`else if`), record-once,
          // churn-mint, and the auth-rebuild arm are untouched; the store
          // read is withRetry fail-soft — no new throw surface inside the
          // recorded try.
          const contender = await this.sessionStore.get(effectiveCtx.agentId, effectiveCtx.threadId);
          const adoptedSessionId =
            contender?.provider === shaping.route.provider &&
            contender.sessionId &&
            contender.sessionId !== effectiveCtx.sessionId
              ? contender.sessionId
              : undefined;
          // Deliberately NOT logging the error string or any handle value:
          // the provider's stale-handle message embeds the resp_ handle
          // (log-redaction posture — KPR-350 §D3 "no handle value"); R2
          // adoption is surfaced as a boolean only.
          log.warn("spawnTurn stale-server-handle — self-heal retry (KPR-350, adopt-or-fresh KPR-351)", {
            agentId: effectiveCtx.agentId,
            threadId: effectiveCtx.threadId,
            provider: shaping.route.provider,
            adoptedContenderHandle: adoptedSessionId !== undefined,
          });
          finalAttemptSessionId = adoptedSessionId;
          finalResult = await this.runOneSpawnAttempt(
            { ...effectiveCtx, sessionId: adoptedSessionId },
            shaping,
            ticket,
            onStream,
          );
        } else if (
          // KPR-399 (§D3): claude-lane resume-rejection self-heal. The
          // persist-on-abort arm (finalizeSpawnResult) creates a class of
          // persisted ids whose resumability is uncertain (mid-tool-call
          // kill, flush timing): the CLI may reject the resume
          // (unknown-session) or the first continuation may 400 on a
          // dangling tool_use. One fresh retry — bounded loss of one
          // thread's context instead of a thread erroring identically until
          // the 7-day row TTL. Semantics inherited from the arms above:
          // `else if` ⇒ at most one retry per turn; record-once untouched
          // (only the finalized attempt reaches the breaker); no pre-scrub —
          // a successful retry overwrites the row via finalize, a failed one
          // leaves it for the next turn's re-trip. SEMANTICS gate
          // (client-transcript = claude + Lane A passthrough) — the KPR-347
          // seam: dead for server-resumable (their resume errors have their
          // own arm) and stateless-replay (nothing to resume). Both matcher
          // surfaces classify non-provider (pinned), so the arm is
          // breaker-invisible either way.
          finalResult.error &&
          isClaudeResumeLoadError(finalResult.error) &&
          effectiveCtx.sessionId &&
          sessionSemanticsForRoute(shaping.route.provider) === "client-transcript"
        ) {
          // Deliberately NOT logging the error string: the CLI's
          // unknown-session surface embeds the session id (log-redaction
          // posture — the KPR-350 arm's "no handle value" rule).
          log.warn("spawnTurn claude resume rejected — one fresh retry (KPR-399)", {
            agentId: effectiveCtx.agentId,
            threadId: effectiveCtx.threadId,
            timedOut: finalResult.timedOut === true,
          });
          // KPR-412: the retry runs fresh — the finalized attempt carries no
          // handle. Mirrors the auth-rebuild arm above; without this,
          // !!finalAttemptSessionId reports a resume that never happened
          // (C7), and the dispatcher's delta-into-fresh mark heal inverts
          // into a mark ADVANCE instead of a clear (C9 gap).
          finalAttemptSessionId = undefined;
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

      const turnResult = this.finalizeSpawnResult(
        effectiveCtx,
        finalResult,
        shaping.route,
        !!finalAttemptSessionId,
      );
      this.recordSpawnObservability(effectiveCtx, shaping, finalResult, !!finalAttemptSessionId);

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
   * downstream finalize path (telemetry skipped; KPR-399's persist-on-abort
   * arm skips this zero-progress shape too — fail-closed) behaves exactly as
   * a real adapter-emitted abort. sessionId is the
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
   * KPR-346 (§D6) + KPR-430: Lane A effort delivery. The runner's deliverable
   * set on a foreign endpoint stays {low,medium,high}; clamping HERE (with a
   * warn) makes the drop explicit at the shaping seam. `source` only shapes
   * the warn text — the caller decides the telemetry source. The substring
   * "outside the deliverable" is load-bearing for the clamp-warn filters in
   * agent-manager.test.ts (KPR-346 T5, KPR-430 T7b/T7d, KPR-392 grok).
   */
  private clampLaneAEffort(
    agentId: string,
    model: string,
    effort: TurnEffort | undefined,
    source: "static" | "suffix",
  ): ReasoningEffort | undefined {
    if (!effort) return undefined;
    if (effort === "low" || effort === "medium" || effort === "high") return effort;
    // Keyed per source (review round 3): the suffix and the static field are
    // distinct drop conditions — a suffix warn must not silence a later
    // static-field drop on the same (agent, model), or vice versa.
    const key = `${agentId}:${model}:${source}`;
    if (!this.laneAEffortClampWarned.has(key)) {
      this.laneAEffortClampWarned.add(key);
      log.warn(
        `${source === "static" ? "Static effort field" : "Lane A :effort suffix"} outside the deliverable {low,medium,high} set — dropped`,
        { agentId, model, effort, source },
      );
    }
    return undefined;
  }

  /**
   * KPR-430 D3: the agent's static `effort`, if deliverable on this
   * Claude-lane turn. Gate ≡ KPR-338's (haiku tier or off-catalog ⇒
   * undeliverable). Warn once per (agent, model) when a set field is
   * dropped — clampLaneAEffort's pattern. Called exactly once per turn,
   * immediately before the router gate (after the voice / round-1 / Lane A /
   * Lane B returns), so Lane B agents never see a spurious off-catalog warn.
   * Tolerates a vanished agentConfig (KPR-306 wedged-permit hazard) and makes
   * NO registry call when the field is unset (non-adopters byte-identical).
   */
  private resolveStaticClaudeEffort(
    agentConfig: AgentConfig | undefined,
    staticTier: ModelTier,
    agentId: string,
  ): AgentEffort | undefined {
    const effort = agentConfig?.effort;
    if (!agentConfig || !isAgentEffort(effort)) return undefined;
    if (staticTier !== "haiku" && getLLMRegistry().supportsEffort(agentConfig.model)) return effort;
    const key = `${agentId}:${agentConfig.model}`;
    if (!this.staticEffortDroppedWarned.has(key)) {
      this.staticEffortDroppedWarned.add(key);
      log.warn("Static effort field set but the agent model cannot receive the effort param — dropped", {
        agentId,
        model: agentConfig.model,
        effort,
        reason: staticTier === "haiku" ? "haiku-tier" : "off-catalog (supportsEffort false)",
        remediation:
          staticTier === "haiku"
            ? "Unset the field or move the agent off haiku."
            : "Add the model to src/llm/catalog.ts with the effort capability, or unset the field.",
      });
    }
    return undefined;
  }

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
    //               legacy maxTurns/budgetUsd are dead config there and are
    //               deliberately NOT folded in (folding them would newly
    //               activate config that has no effect today); timeoutMs is
    //               live since KPR-422 — resolveResourceLimits itself folds
    //               the agent's top-level timeoutMs in, so the base here
    //               matches what a round-0 turn would receive.
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
        ? resolveResourceLimits(staticTier, agentConfig.resourceTiers, agentConfig.timeoutMs)
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
    // KPR-430: the pin wins over the static field (never consulted here);
    // source stamped only where the pin was actually deliverable.
    return {
      prompt,
      route: staticRoute,
      resourceLimits: limits,
      routerCostUsd: 0,
      effortOverride,
      ...(effortOverride ? { effortSource: "pin" as const } : {}),
    };
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
    // the breaker's record() and wedging a half-open probe permit until the
    // probe's own stale bound (deadlineMs + grace; 360s meta-less fallback —
    // KPR-400). The degenerate route ({provider:"claude", model:""})
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
    // keyed on the static provider (≡ effective under the W3 clamp): Lane B
    // targets keep the conservative pilot-era default (no conversation_search
    // clause) pending a dedicated follow-up, not because they lack tools —
    // KPR-348 gave them real tool execution.
    if (ctx.sessionHandoff) {
      // KPR-346 (§D7): variant keys on CLAUDE-RUNTIME LANE MEMBERSHIP, not
      // === "claude" — Lane A agents run the full runtime and have
      // conversation_search. Future ids fail toward the conservative Lane B
      // variant (safe default).
      prompt =
        (staticRoute.provider === "claude" || isLaneAProvider(staticRoute.provider)
          ? SESSION_HANDOFF_NOTICE_CLAUDE
          : SESSION_HANDOFF_NOTICE_PILOT) + prompt;
    }

    // KPR-389: round-1 conference reactions spawn cheap — classifier skipped,
    // effort pinned low where deliverable, limits clamped. Round 0 falls
    // through to every existing path untouched (D3). Voice is structurally
    // unreachable here (carve-out returned above; voice never carries the meta).
    if (ctx.conferenceRound === 1) {
      return this.shapeReactionTurn(prompt, staticRoute, staticTier, agentConfig, ctx.agentId);
    }

    // KPR-346 (§D6) + KPR-430: Lane A — the router stays skipped (foreign ids
    // are off-catalog, supportsEffort false, KPR-322 rule stands; zero
    // classifier cost). The static `effort` field wins over the :effort
    // suffix; either delivers through the Claude adapter's existing channel
    // via the {low,medium,high} clamp (no suffix fallback once the field is
    // set — a dropped field delivers nothing). resourceLimits stays undefined
    // — the runner's per-agent legacy fallback applies; Claude static-tier
    // limits are never computed for foreign models.
    if (isLaneAProvider(staticRoute.provider)) {
      const fieldEffort = agentConfig && isAgentEffort(agentConfig.effort) ? agentConfig.effort : undefined;
      const source: "static" | "suffix" = fieldEffort !== undefined ? "static" : "suffix";
      const effortOverride = this.clampLaneAEffort(
        ctx.agentId,
        agentConfig?.model ?? "",
        fieldEffort ?? ("reasoningEffort" in staticRoute ? staticRoute.reasoningEffort : undefined),
        source,
      );
      return {
        prompt,
        route: staticRoute,
        resourceLimits: undefined,
        routerCostUsd: 0,
        effortOverride,
        ...(effortOverride ? { effortSource: source } : {}),
      };
    }

    // Lane B (non-Claude, non-Lane-A) providers: the router stays skipped
    // (R-311.2 pilot gate), but resourceLimits must be supplied here — the
    // Lane B adapters have no runner-side legacy fallback, so an undefined
    // limit silently fell through to each adapter's DEFAULT_MAX_ROUNDS (10)
    // and the agent definition's maxTurns was dead config. That default was
    // unreachable in the tool-free pilot era; post-KPR-348 tool execution it
    // truncated real turns (error_max_turns). Mirror the Claude runner's
    // legacy fallback (agent-def maxTurns/timeoutMs/budgetUsd). maxTurns
    // bounds the round budget and timeoutMs the wall clock (all three
    // adapters arm an abort-signal deadline; expiry surfaces as
    // TURN_DEADLINE_SUBTYPE — the breaker-inconclusive turn-deadline kind:
    // never a trip, never a streak reset, never a probe close); budgetUsd
    // is still inert on Lane B.
    if (agentConfig && staticRoute.provider !== "claude") {
      // KPR-430: the static effort field is a documented no-op on Lane B
      // (request.effort is ignored by contract — the :effort suffix is the
      // lever there). Say so once per (agent, model) rather than silently.
      if (isAgentEffort(agentConfig.effort)) {
        const key = `${ctx.agentId}:${agentConfig.model}`;
        if (!this.laneBEffortFieldWarned.has(key)) {
          this.laneBEffortFieldWarned.add(key);
          log.warn("Static effort field is not delivered on this provider — use the model's :effort suffix instead", {
            agentId: ctx.agentId,
            model: agentConfig.model,
            provider: staticRoute.provider,
            effort: agentConfig.effort,
          });
        }
      }
      return {
        prompt,
        route: staticRoute,
        resourceLimits: {
          maxTurns: agentConfig.maxTurns,
          timeoutMs: agentConfig.timeoutMs ?? 300_000, // 5 min default (agent-config contract)
          budgetUsd: agentConfig.budgetUsd,
        },
        routerCostUsd: 0,
        effortOverride: undefined,
      };
    }

    // KPR-430 D3: the static field is resolved exactly once per turn, HERE —
    // after the voice / round-1 / Lane A / Lane B returns and before the
    // router gate — and rides every remaining claude-lane path: router-off,
    // system-sender (cron, reflection, bg-/code-task callbacks,
    // meeting-monitor prompts, worker-pool boss re-entry, first-boot), the
    // haiku/off-catalog skip (where it resolves undefined + warns), and the
    // router-on path (where it short-circuits the classifier below).
    // resourceLimits: router-off keeps undefined (runner legacy fallback);
    // system-sender receives the static-tier envelope — KPR-431, below.
    const staticEffort = this.resolveStaticClaudeEffort(agentConfig, staticTier, ctx.agentId);

    // Router gate (KPR-311): skip when disabled, when the agent vanished
    // mid-turn (guard above — MUST stay the first disjunct: with no config
    // there is no tier to resolve, and the turn has to flow on to fail inside
    // the recorded try, KPR-306 wedged-permit hazard), or when the agent's
    // static provider isn't Claude (pilot gate — calling the router for a
    // pilot charged routerCostUsd for an output the pilot ignores and
    // misattributed the Claude model in telemetry/audit — R-311.2; Lane A/B
    // returned above, so this disjunct is belt-and-braces here). System
    // senders no longer return here — KPR-431, below.
    if (!agentConfig || !appConfig.modelRouter.enabled || staticRoute.provider !== "claude") {
      return {
        prompt,
        route: staticRoute,
        resourceLimits: undefined,
        routerCostUsd: 0,
        effortOverride: staticEffort,
        ...(staticEffort ? { effortSource: "static" as const } : {}),
      };
    }

    // KPR-338: the turn's model is ALWAYS agentConfig.model (fixed-tier
    // invariant, kpr-338-spec §1.3). Execution bounds derive from the agent's
    // STATIC tier, explicitly NOT effort-keyed. KPR-422: the agent's
    // top-level timeoutMs participates in the resolution (tier override >
    // top-level > tier default) — it is no longer dead config on this path.
    // KPR-431: computed BEFORE the sender check so every Claude/router-on
    // turn — human, system, classifier-failed — resolves the same envelope;
    // the agent-def maxTurns/budgetUsd are dead config on this whole path.
    const staticLimits = resolveResourceLimits(staticTier, agentConfig.resourceTiers, agentConfig.timeoutMs);

    // KPR-431: system senders (scheduler/cron, reflection, callback/event
    // deliveries, bg-/code-task completion callbacks, meeting-monitor prompts,
    // worker-pool boss re-entry, first-boot) skip the classifier exactly as
    // before (R-311 — no routerCostUsd, no effort hint) but receive the SAME
    // static-tier envelope a human turn on this agent receives. This
    // deliberately supersedes kpr-338-spec §3.2 rules (a)/(b) for this path
    // (KPR-431). An agent's envelope is a per-agent fact, never a per-sender
    // one. Placed before the haiku/off-catalog skip so its warn-once keeps
    // firing only on paths where an effort hint could have been delivered.
    // KPR-430's static effort field rides this branch exactly as it rode the
    // gate return it replaces (a system turn with a static effort delivers it).
    if (item.sender === "system") {
      return {
        prompt,
        route: staticRoute,
        resourceLimits: staticLimits,
        routerCostUsd: 0,
        effortOverride: staticEffort,
        ...(staticEffort ? { effortSource: "static" as const } : {}),
      };
    }

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

    // KPR-430 D4: static field set and deliverable ⇒ the classifier's only
    // output would be discarded — skip the call (no sidecar latency, no
    // routerCostUsd). Shape is the merge branch's, minus the call.
    if (staticEffort !== undefined) {
      return {
        prompt,
        route: staticRoute,
        resourceLimits: staticLimits,
        routerCostUsd: 0,
        effortOverride: staticEffort,
        effortSource: "static",
      };
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
      // KPR-430: source stamped only when the classifier actually returned an
      // effort — routeModel's no-key and fallback paths return none.
      return {
        prompt,
        route: staticRoute,
        resourceLimits: staticLimits,
        routerCostUsd: result.costUsd,
        effortOverride: result.effort,
        ...(result.effort ? { effortSource: "router" as const } : {}),
      };
    } catch (err) {
      // Belt-and-braces (routeModel owns its own fallback and should not
      // throw). KPR-431: a classifier fault costs the effort hint only — the
      // static-tier envelope is a per-agent fact computed above and is
      // delivered regardless (supersedes the KPR-338 "resourceLimits stays
      // undefined" degenerate shape on this path).
      log.warn("Model router failed, using defaults", { agentId: ctx.agentId, error: String(err) });
      return { prompt, route: staticRoute, resourceLimits: staticLimits, routerCostUsd: 0, effortOverride: undefined };
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
    resumedSession: boolean,
  ): void {
    const item = ctx.workItem;
    // KPR-389 D6: turn-kind discriminators from the dispatcher's conference meta.
    const confRound = conferenceRoundOf(item);
    const injectionMode = conferenceInjectionModeOf(item);

    // Per-turn telemetry — independent of sessionStore (no history in
    // sessionStore.set). Aggregator in `hive doctor` reads this collection.
    // KPR-401: aborted turns with real spend are recorded (sparse aborted
    // flag on the doc); zero-usage aborted turns — operator abort before the
    // first API call, and the manager's synthesizeAbortedResult early-abort
    // shape (resumed sessionId, never spawned) — stay out: nothing to
    // account, no noise docs. Deliberately provider-AGNOSTIC: Lane B
    // adapters already return real partial totals on operator-aborted
    // turns, and that spend is just as real — do not provider-gate this.
    const hadUsage =
      result.inputTokens + result.outputTokens + result.cacheReadTokens + result.cacheCreationTokens > 0;
    if (result.sessionId && (!result.aborted || hadUsage)) {
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
          // KPR-389: perf split + turn kind (conditional spreads keep absent
          // keys absent — no BSON nulls on non-conference turns).
          durationMs: result.durationMs,
          llmMs: result.llmMs,
          toolMs: result.toolMs,
          toolCalls: result.toolCalls,
          resumedSession,
          // KPR-430 D6: effortSource nests INSIDE the effort spread — it can
          // never land without effort, whatever a shaping site did.
          ...(shaping.effortOverride
            ? {
                effort: shaping.effortOverride,
                ...(shaping.effortSource ? { effortSource: shaping.effortSource } : {}),
              }
            : {}),
          ...(confRound !== undefined ? { conferenceRound: confRound } : {}),
          ...(injectionMode ? { injectionMode } : {}),
          // KPR-401: sparse — only aborted:true is ever written.
          ...(result.aborted ? { aborted: true as const } : {}),
          // KPR-434 D6: sparse memory flags (the KPR-401 `aborted` shape —
          // only ever written true; absent keys stay absent).
          ...(result.memoryDigestInjected !== undefined ? { memoryInjected: true as const } : {}),
          ...(result.memoryRenderFailed ? { memoryRenderFailed: true as const } : {}),
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
    // KPR-393 §D2: fleet-wide intent-trailer telemetry — boolean only, no
    // text stored (redaction posture). Error turns are skipped even when
    // text is present (a delivered error is not a promise). Every provider
    // runs the detector — the Claude lane's rate is the phase-2 control.
    const intentTrailer = !result.error && detectIntentTrailer(result.text);
    if (intentTrailer) {
      log.info("Intent trailer detected", {
        agentId: ctx.agentId,
        model: this.registry.get(ctx.agentId)?.model ?? "unknown",
        toolCalls: result.toolCalls,
      });
    }
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
      ...(confRound !== undefined ? { conferenceRound: confRound } : {}),
      ...(intentTrailer ? { intentTrailer: true as const } : {}),
      // KPR-401: sparse abort flags — the audit row's costUsd:0/durationMs
      // zeros on aborted turns are now segmentable instead of masquerading
      // as free, instant, clean turns.
      ...(result.aborted ? { aborted: true } : {}),
      ...(result.timedOut ? { timedOut: true } : {}),
    });
  }

  private finalizeSpawnResult(
    ctx: TurnContext,
    result: RunResult,
    route: ProviderModelRoute,
    resumedSession: boolean,
  ): TurnResult {
    const newSessionId = result.sessionId || ctx.sessionId || "";
    // KPR-399 (§D2): an aborted claude-lane turn with observed progress
    // persists its session so replays/retries/follow-ups RESUME instead of
    // restarting from scratch. client-transcript ONLY (cross-epic canon C3 —
    // claude + Lane A kimi/deepseek/grok): the id is a local transcript
    // handle the CLI flushed incrementally, and observed progress (the
    // exported KPR-398 D1 predicate — one source of truth with the
    // classifier) is the proof it actually ran. Zero-progress aborts persist
    // nothing (fail-closed = pre-399 behavior): the id may point at a
    // never-flushed file, and a rotated id with zero progress is
    // indistinguishable from a failed-resume mint (churn-mint's own
    // rationale). Lane B (server-resumable / stateless-replay) keeps the
    // !aborted behavior byte-for-byte — resume-on-abort there goes through
    // the KPR-385 scaffold hooks, never a silent unification here.
    const abortPersist =
      result.aborted === true &&
      !!result.sessionId &&
      sessionSemanticsForRoute(route.provider) === "client-transcript" &&
      hasObservedProgress(result) &&
      // Mint-safety belt (the ⚠A4 churn-mint condition, applied verbatim):
      // an aborted turn that ALSO errored, resumed a session, and came back
      // with a DIFFERENT id never overwrites the row. Rare shape (deadline
      // aborts carry no error), but it makes this arm self-evidently
      // mint-safe.
      !(result.error && ctx.sessionId && result.sessionId !== ctx.sessionId);

    if (result.sessionId && !result.aborted) {
      // KPR-313 §3.2: persist a resumable handle ONLY for providers whose
      // adapters actually resume. Stateless pilots keep the ROW (the session
      // store doubles as the dispatcher's thread→agent map via
      // findAgentByThread) with an empty sessionId — the row persists, the
      // fake handle never does.
      const resumable = persistsResumableHandle(sessionSemanticsForRoute(route.provider));
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
    } else if (abortPersist) {
      log.info("Persisting session from aborted turn — replay/follow-up will resume (KPR-399)", {
        agentId: ctx.agentId,
        threadId: ctx.threadId,
        timedOut: result.timedOut === true,
      });
      // NO tokenData: deliberate. Post-KPR-401 an aborted turn CAN carry real
      // partial usage (streamed-usage accumulator), but back-filling the
      // session row's tokenData from a partial snapshot is a recorded
      // follow-up (epic canon D15), not this write's job — set() without
      // tokenData updates only sessionId/provider/updatedAt, preserving the
      // prior turn's stats (session-store.ts set(): defaults land
      // $setOnInsert-only).
      this.sessionStore.set(ctx.agentId, ctx.threadId, result.sessionId, route.provider);
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
      resumedSession,
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
    // KPR-390: abort this boss's live meeting workers (claims stay `running`;
    // the watchdog/restart sweep own the honest expiry notice).
    this.workerPool?.abortForBoss(agentId);
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
