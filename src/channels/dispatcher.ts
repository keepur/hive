import { createLogger } from "../logging/logger.js";
import type { WorkItem, WorkResult } from "../types/work-item.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import { isBroadcastCapable } from "./channel-adapter.js";
import type { AgentManager, TurnContext, TurnResult, SpawnTurnStreamCallback } from "../agents/agent-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { HealthReporter } from "../health/health-reporter.js";
import type { TaskLedger } from "../tasks/task-ledger.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import type { RetryQueue } from "../sweeper/retry-queue.js";
import type { SlackAdapter, ThreadMessage } from "./slack-adapter.js";
import type { RunResult } from "../agents/agent-runner.js";
import { classifyMeetingMessage, type RosterMember } from "../agents/meeting-classifier.js";
import { ProviderCircuitOpenError } from "../agents/provider-circuit-breaker.js";
import { classifyTurnResult, HARD_FAULT_KINDS } from "../agents/provider-adapters/error-classification.js";
import type { OutageQueueStore, OutageQueueConfig } from "../outage/outage-queue-store.js";
import {
  OutageEpisodeTracker,
  adapterKeyFor,
  outageNoticeFor,
  overflowNoticeFor,
  policyFor,
  terminalFailureNotice,
  threadKeyFor,
} from "../outage/outage-notices.js";

const log = createLogger("dispatcher");

/** Max length for status queries — anything longer is real content, not a status check */
const STATUS_MAX_LENGTH = 80;

const STATUS_PATTERNS = [
  /^status\??$/i,
  /^how.{0,20}(everyone|agents?|doing|running)/i,
  /^health\??$/i,
  /^system status/i,
];

/** Patterns that indicate the agent chose not to respond — suppress delivery */
const NON_RESPONSE_PATTERNS = [
  /^no response (requested|needed|required|necessary)\.?$/i,
  /^\(no response\)$/i,
  /^n\/a\.?$/i,
];

/** Extended resolved-agent type carrying optional conference metadata */
interface ResolvedAgent {
  agentId: string;
  conferenceMode?: boolean;
  conferenceHumanTs?: string;
  conferenceRound?: number; // 0 = human-triggered, 1 = peer reaction
  threadContext?: string;
  meetingPreamble?: string;
}

/**
 * KPR-308 §5.3: breaker dependency seam. `true` = outage mode active.
 * The dispatcher must NOT import KPR-306's breaker implementation — index.ts
 * wires whatever surface KPR-306 exports into this one-function seam, in a
 * later integration step. Until then the stub default keeps the slice dormant.
 */
export type OutageStateProvider = () => boolean;

/**
 * KPR-307: honest-outage handling seam. Injected via `setOutageHandling`
 * only when `config.outageQueue.enabled` is true; when absent every outage
 * path in the dispatcher is dormant and behavior is identical to post-KPR-306
 * raw error surfacing.
 */
export interface OutageHandlingDeps {
  store: OutageQueueStore;
  episodes: OutageEpisodeTracker;
  config: OutageQueueConfig;
}

export class Dispatcher {
  private adapters = new Map<string, ChannelAdapter>();
  private registry: AgentRegistry;
  private agentManager: AgentManager;
  private healthReporter: HealthReporter;
  private defaultAgentId: string;
  private threadAgentMap = new Map<string, string>(); // threadId -> agentId (single-agent threads)
  private threadParticipants = new Map<string, Set<string>>(); // threadId -> agentIds (multi-agent threads)
  private threadAgentLastSeen = new Map<string, number>();
  private recentMessageIds = new Map<string, number>(); // messageTs -> timestamp (dedup)
  private auditAdapter?: ChannelAdapter;
  private auditChannelIds?: Map<string, string>; // slack channel name → id
  private fallbackAuditChannelId?: string;
  private taskLedger?: TaskLedger;
  private retryQueue?: RetryQueue;
  private outageStateProvider: OutageStateProvider = () => false;
  private outage?: OutageHandlingDeps;
  private teamStore?: import("../team/team-store.js").TeamStore;
  private slackAdapter?: SlackAdapter;
  private meetingRosters = new Map<string, Set<string>>(); // threadId → agent IDs
  // Map<threadId, Map<humanMessageTs, Set<agentId>>> — tracks which agents reacted in round 1
  private meetingReactionTracker = new Map<string, Map<string, Set<string>>>();

  private static readonly DEDUP_TTL_MS = 60_000; // 1 minute TTL for dedup entries

  constructor(
    registry: AgentRegistry,
    agentManager: AgentManager,
    healthReporter: HealthReporter,
    defaultAgentId: string,
    taskLedger?: TaskLedger,
  ) {
    this.registry = registry;
    this.agentManager = agentManager;
    this.healthReporter = healthReporter;
    this.defaultAgentId = defaultAgentId;
    this.taskLedger = taskLedger;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
  }

  setRetryQueue(queue: RetryQueue): void {
    this.retryQueue = queue;
  }

  setOutageStateProvider(fn: OutageStateProvider): void {
    this.outageStateProvider = fn;
  }

  /**
   * KPR-307: wire honest-outage handling. Never called when
   * `config.outageQueue.enabled` is false — in that case every path below is
   * dormant and behavior is identical to post-KPR-306 raw error surfacing.
   */
  setOutageHandling(deps: OutageHandlingDeps): void {
    this.outage = deps;
  }

  setTeamStore(store: import("../team/team-store.js").TeamStore): void {
    this.teamStore = store;
  }

  setAuditChannel(adapter: ChannelAdapter, channelIdByName: Map<string, string>, fallbackChannelId?: string): void {
    this.auditAdapter = adapter;
    this.auditChannelIds = channelIdByName;
    this.fallbackAuditChannelId = fallbackChannelId;
  }

  setSlackAdapter(adapter: SlackAdapter): void {
    this.slackAdapter = adapter;
  }

  async dispatch(item: WorkItem): Promise<void> {
    // 0. Deduplicate — if two adapters see the same Slack message, only process it once.
    //    KPR-307: outage replays are engine-authored redispatches of the ORIGINAL
    //    item id (no synthetic per-attempt id — Finding 1 r1: §5-2g doesn't count
    //    fast-fails, so a synthetic id would repeat and dedup would silently drop
    //    every replay after the first). Dedup exists for externally-duplicated
    //    deliveries; a replay has nothing to dedup against — bypass it.
    if (this.recentMessageIds.has(item.id) && !item.meta?.outageReplay) {
      log.debug("Duplicate message skipped", { id: item.id, source: item.source.adapterId });
      return;
    }
    this.recentMessageIds.set(item.id, Date.now());
    this.pruneDedup();

    // 1. Intercept status queries (short messages only — long messages are real content)
    const trimmed = item.text.trim();
    if (trimmed.length <= STATUS_MAX_LENGTH && STATUS_PATTERNS.some((p) => p.test(trimmed))) {
      log.info("Status query intercepted", { source: item.source.kind, text: trimmed });
      const statusText = this.healthReporter.formatForSlack();
      const adapter = this.adapters.get(item.source.adapterId ?? item.source.kind);
      if (adapter) {
        try {
          await adapter.deliver({
            text: statusText,
            agentId: "system",
            workItem: item,
            costUsd: 0,
            durationMs: 0,
          });
        } catch (err) {
          log.warn("Status delivery failed, queuing for retry", { error: String(err) });
          this.retryQueue?.enqueue(
            { text: statusText, agentId: "system", workItem: item, costUsd: 0, durationMs: 0 },
            adapter,
          );
        }
      }
      return;
    }

    // KPR-307 (§7.2, Finding 6 r2): a replay resolves ONLY via its pinned
    // agent. If the pinned agent was deleted (resolveAgents step 0 would fall
    // through to name/channel matching — a substitute must NOT answer) or
    // disabled (the disabled filter would return empty), the queued doc
    // terminates as `expired`. This single pre-check subsumes both
    // early-return paths for replay items; non-replay items are untouched.
    if (this.outage && item.meta?.outageReplay) {
      const pinnedId = item.meta.targetAgentId as string | undefined;
      const pinned = pinnedId ? this.registry.get(pinnedId) : undefined;
      if (!pinned || pinned.disabled) {
        log.warn("Outage replay expired — pinned agent deleted or disabled", {
          itemId: item.id,
          agentId: pinnedId,
        });
        if (pinnedId) {
          await this.outage.store
            .release(item.id, pinnedId, "expired", "agent disabled/deleted — will not be replayed")
            .catch((err) => log.error("Outage replay expire-release failed", { error: String(err) }));
        }
        return;
      }
    }

    // 2. Resolve agent(s) — may fan out to multiple when several agents are named
    const resolvedList = await this.resolveAgents(item);
    if (resolvedList.length === 0) {
      log.warn("No agent found for work item", {
        source: item.source.kind,
        label: item.source.label,
        text: item.text.slice(0, 50),
      });
      return;
    }

    // 2b. Filter out disabled agents
    const activeList = resolvedList.filter(({ agentId }) => {
      const agentConfig = this.registry.get(agentId);
      if (agentConfig?.disabled) {
        log.info("Message dropped — agent is disabled", { agentId, source: item.source.kind });
        return false;
      }
      return true;
    });
    if (activeList.length === 0) return;

    // Conference mode: always route through dispatchToAgent for context injection
    const isConference = activeList.some((r) => r.conferenceMode);
    if (isConference) {
      const threadId = item.threadId ?? item.id;
      this.threadAgentLastSeen.set(threadId, Date.now());
      log.info("Conference fan-out", {
        agents: activeList.map((r) => r.agentId),
      });
      await Promise.all(activeList.map((r) => this.dispatchToAgent(item, r)));
      return;
    }

    // Fan-out: if multiple agents resolved, dispatch to each concurrently
    if (activeList.length > 1) {
      const threadId = item.threadId ?? item.id;
      // Persist participant set so follow-up messages fan out to all participants
      if (!this.threadParticipants.has(threadId)) {
        this.threadParticipants.set(threadId, new Set(activeList.map((r) => r.agentId)));
      }
      this.threadAgentLastSeen.set(threadId, Date.now());
      log.info("Multi-agent fan-out", {
        agents: activeList.map((r) => r.agentId),
      });
      await Promise.all(activeList.map((r) => this.dispatchToAgent(item, r)));
      return;
    }

    const { agentId } = activeList[0];

    const threadId = item.threadId ?? item.id;
    this.threadAgentMap.set(threadId, agentId);
    this.threadAgentLastSeen.set(threadId, Date.now());

    // 3. Track in task ledger (fire-and-forget — never blocks pipeline)
    const tracked = this.taskLedger?.shouldTrack(item) ?? false;
    if (tracked) {
      this.taskLedger!.onDispatch(item, agentId).catch((err) =>
        log.warn("Task ledger dispatch failed", { error: String(err) }),
      );
    }

    const adapter = this.adapters.get(item.source.adapterId ?? item.source.kind);

    // 4. Full agent processing
    await adapter?.onProcessingStart?.(item, agentId);
    try {
      const runResult = this.convertTurnResult(await this.agentManager.runWorkItemTurn(agentId, item));

      // KPR-307 (§7.2 second leg): a COMPLETED turn with a hard provider fault
      // — or a hang-type timeout — while this provider's breaker is open is a
      // probe-failure / trip-crossing turn: queue + notice instead of
      // delivering "Something went wrong: …" or a bare "_No response._".
      if (await this.maybeHandlePostTurnOutage(item, agentId, adapter, runResult)) {
        return;
      }

      // KPR-307 (§5-2g): a replay attempt that errored with the breaker
      // CLOSED is a real failure — attempts+1, terminal `failed` at the cap
      // (with a plain-text notice on notify policy). The raw error result is
      // never delivered for a replay item: SMS/iMessage would swallow it and
      // Slack would spam one per attempt.
      // Deliberate: this also fires with the breaker still OPEN when the
      // result classifies as `non-provider` (maybeHandlePostTurnOutage above
      // only handles HARD_FAULT_KINDS) — a tool error is outage-independent,
      // so it counts as a real attempt regardless of breaker state.
      if (this.outage && item.meta?.outageReplay && runResult.error) {
        await this.resolveReplayRealFailure(item, agentId, adapter, runResult.error);
        return;
      }

      const trimmedText = runResult.text.trim();
      const isNonResponse = NON_RESPONSE_PATTERNS.some((p) => p.test(trimmedText));

      if (isNonResponse) {
        log.info("Non-response suppressed", {
          agentId,
          source: item.source.kind,
          text: trimmedText,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
        });
      } else {
        const workResult: WorkResult = {
          text: runResult.text || "_No response._",
          agentId,
          workItem: item,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
          error: runResult.error,
        };

        await this.deliverAgentResult(workResult, adapter);

        if (tracked) {
          this.taskLedger!.onComplete(workResult).catch((err) =>
            log.warn("Task ledger complete failed", { error: String(err) }),
          );
        }

        if (this.auditAdapter && item.source.kind !== this.auditAdapter.kind) {
          await this.postAuditLog(workResult);
        }

        log.info("Work item dispatched", {
          agentId,
          source: item.source.kind,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
          llmMs: runResult.llmMs,
          toolMs: runResult.toolMs,
          toolCalls: runResult.toolCalls,
          toolSummary: runResult.toolSummary,
        });
      }

      // KPR-307: success bookkeeping — replay doc → done (delivered OR
      // non-response-suppressed: the model chose not to answer, nothing left
      // to redeliver); episode ends only while this provider's breaker is
      // observed not-open at this moment (Finding 3 r1 — a pre-trip turn
      // landing after the trip must not clear the episode mid-outage).
      if (!runResult.error) {
        await this.recordTurnSuccess(item, agentId);
      }
    } catch (err) {
      await this.handleTurnFailure(err, item, agentId, adapter);
    } finally {
      await adapter?.onProcessingEnd?.(item, agentId);
    }
  }

  /** Evict stale dedup entries to prevent memory growth */
  private pruneDedup(): void {
    const cutoff = Date.now() - Dispatcher.DEDUP_TTL_MS;
    for (const [id, ts] of this.recentMessageIds) {
      if (ts < cutoff) this.recentMessageIds.delete(id);
    }
  }

  /**
   * KPR-220 Phase 9: TurnResult → RunResult conversion. Per-turn is now the
   * only execution path; the dispatcher unconditionally routes through
   * `agentManager.runWorkItemTurn` and converts the `TurnResult` into the
   * legacy `RunResult` shape that downstream delivery + audit code expects.
   *
   * Every field of `RunResult` MUST be mapped explicitly here. The extraction
   * to a named private helper (vs. inline at call sites) is a plan-review
   * constraint: an inline conversion could silently drop a field and still
   * compile — the named helper makes the mapping auditable.
   */
  private convertTurnResult(turn: TurnResult): RunResult {
    return {
      text: turn.finalMessage,
      sessionId: turn.newSessionId,
      costUsd: turn.usage.costUsd,
      durationMs: turn.usage.durationMs,
      inputTokens: turn.usage.inputTokens,
      outputTokens: turn.usage.outputTokens,
      cacheReadTokens: turn.usage.cacheReadTokens,
      cacheCreationTokens: turn.usage.cacheCreationTokens,
      contextWindow: turn.usage.contextWindow,
      llmMs: turn.llmMs,
      toolMs: turn.toolMs,
      toolCalls: turn.toolCalls,
      toolSummary: turn.toolSummary ?? "",
      streamed: turn.streamed,
      compactions: turn.compactions,
      preCompactTokens: turn.preCompactTokens,
      ephemeral5mTokens: turn.ephemeral5mTokens,
      ephemeral1hTokens: turn.ephemeral1hTokens,
      error: turn.errors[0],
      // KPR-307: aborted/timedOut ARE now read downstream — the post-turn
      // outage gate classifies `timedOut && aborted` as a hang-type provider
      // fault (the pre-KPR-307 hardcoded `aborted: false` claimed "never read
      // downstream"; that stopped being true here).
      aborted: turn.aborted ?? false,
      timedOut: turn.timedOut,
    };
  }

  /**
   * KPR-308 §5.2: outage-mode delivery preference. Applied at both agent-
   * response delivery sites before the source adapter is used. Diverts to a
   * WS broadcast only when ALL hold: the result carries no error; outage mode
   * active; the handling agent is floorCritical; the item is slack- or
   * scheduler-sourced (app/team/sms replies already route correctly and must
   * never divert); the ws adapter is registered and broadcast-capable; and at
   * least one device is connected (deliverBroadcast's returned count is the
   * authoritative check — no redundant connectionCount pre-check). Any
   * failure or zero-count falls through to the normal source-adapter path.
   *
   * The "scheduler" leg is defensive: ChannelKind includes it, but nothing
   * produces it today — the scheduler synthesizes kind:"slack" sources.
   */
  private async tryOutageDiversion(result: WorkResult): Promise<boolean> {
    // Review advisory: error-carrying results always deliver via the source
    // adapter — no error frames on the floor broadcast.
    if (result.error) return false;
    if (!this.outageStateProvider()) return false;
    const sourceKind = result.workItem.source.kind;
    if (sourceKind !== "slack" && sourceKind !== "scheduler") return false;
    if (this.registry.get(result.agentId)?.floorCritical !== true) return false;
    const wsAdapter = this.adapters.get("ws");
    if (!wsAdapter || !isBroadcastCapable(wsAdapter)) return false;

    try {
      const delivered = await wsAdapter.deliverBroadcast(result);
      if (delivered === 0) {
        log.info("Outage diversion: no connected devices, falling through", {
          agentId: result.agentId,
          sourceKind,
        });
        return false;
      }
      // Log-redaction convention: agent id, source kind, count — no message text.
      log.info("Outage diversion: delivered via app broadcast", {
        agentId: result.agentId,
        sourceKind,
        connections: delivered,
      });
      return true;
    } catch (err) {
      log.warn("Outage diversion: broadcast failed, falling through", {
        agentId: result.agentId,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * KPR-308: shared agent-response delivery for the two dispatch paths.
   * Diversion guard first; otherwise the pre-existing source-adapter
   * delivery with retry-queue semantics, unchanged.
   */
  private async deliverAgentResult(workResult: WorkResult, sourceAdapter: ChannelAdapter | undefined): Promise<void> {
    if (await this.tryOutageDiversion(workResult)) return;
    if (!sourceAdapter) return;
    try {
      await sourceAdapter.deliver(workResult);
    } catch (err) {
      log.warn("Agent response delivery failed, queuing for retry", { error: String(err) });
      this.retryQueue?.enqueue(workResult, sourceAdapter);
    }
  }

  // -------------------------------------------------------------------------
  // KPR-307: honest outage behavior — interception, notices, replay outcomes.
  // Every branch below is a no-op when setOutageHandling was never called.
  // -------------------------------------------------------------------------

  /**
   * Shared failure handler — extracted from the two near-duplicate catch
   * bodies (pre-existing debt this change would otherwise triple). §7.2
   * classification:
   *   - ProviderCircuitOpenError            → outage path (provider from err)
   *   - thrown legacy error on a replay     → release doc → pending, attempts
   *     unchanged (transient resource contention — e.g. "Spawn budget
   *     exceeded" — is not a provider verdict; Finding 2 r2: without this the
   *     doc strands in `replaying` forever), then today's error delivery
   *   - everything else                     → today's error path, unchanged.
   */
  private async handleTurnFailure(
    err: unknown,
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
  ): Promise<void> {
    if (this.outage) {
      if (err instanceof ProviderCircuitOpenError) {
        const handled = await this.handleOutageTurn(item, agentId, adapter, err.provider);
        if (handled) return;
      } else if (item.meta?.outageReplay) {
        await this.outage.store
          .release(item.id, agentId, "pending", String(err))
          .catch((releaseErr) => log.error("Outage replay release failed", { error: String(releaseErr) }));
      }
    }

    const errorResult: WorkResult = {
      text: `Something went wrong: ${String(err)}`,
      agentId,
      workItem: item,
      costUsd: 0,
      durationMs: 0,
      error: String(err),
    };
    if (adapter) {
      try {
        await adapter.deliver(errorResult);
      } catch (deliverErr) {
        log.warn("Error delivery failed, queuing for retry", { error: String(deliverErr) });
        this.retryQueue?.enqueue(errorResult, adapter);
      }
    }
    log.error("Dispatch failed", { agentId, error: String(err) });
  }

  /**
   * §7.2 second classification leg (post-turn gate): the turn COMPLETED but
   * the provider's breaker is open. Fires when the result classifies into
   * HARD_FAULT_KINDS OR `timedOut && aborted` (Finding 3 r2 — a runner-
   * deadline timeout typically leaves `error` unset, so `errors` alone never
   * fires for hang-type outages). Gated on snapshot.enabled so shadow mode
   * stays fully observational. A `non-provider` classification with the
   * breaker coincidentally open follows the LEGACY path — a partially-
   * executed tool turn's side effects must not be silently re-run
   * (Finding 4 r1).
   */
  private async maybeHandlePostTurnOutage(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    runResult: RunResult,
  ): Promise<boolean> {
    const outage = this.outage;
    if (!outage) return false;
    if (!runResult.error && runResult.timedOut !== true) return false; // healthy turn — cheap exit

    const provider = this.agentManager.providerFor(agentId);
    if (!provider) return false;
    const snapshot = this.agentManager.circuitBreakers.stateFor(provider);
    if (!snapshot || snapshot.state !== "open" || snapshot.enabled !== true) return false;

    const classification = classifyTurnResult({
      error: runResult.error,
      timedOut: runResult.timedOut,
      aborted: runResult.aborted,
    });
    const hardFault = classification.outcome === "fault" && HARD_FAULT_KINDS.has(classification.kind);
    const hangTimeout = runResult.timedOut === true && runResult.aborted === true;
    if (!hardFault && !hangTimeout) return false;

    return this.handleOutageTurn(item, agentId, adapter, provider);
  }

  /**
   * §7.2 outage path. Returns true when the turn was fully handled (queued /
   * released / skipped / overflow-noticed); false only on a store failure —
   * the caller then falls back to the legacy error path rather than dropping
   * the turn with no user-visible signal at all.
   */
  private async handleOutageTurn(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    provider: string,
  ): Promise<boolean> {
    const outage = this.outage;
    if (!outage) return false;

    const policy = policyFor(item);
    if (policy === "skip") {
      log.info("Outage fast-fail skipped — cron turn re-fires at next match", { agentId, provider });
      return true;
    }

    if (outage.episodes.begin(provider)) {
      // Sustained-condition discipline (§7.6): one warn per episode start.
      log.warn("Outage episode began — provider circuit open, queueing turns for replay", { provider, agentId });
    }

    // Release-before-depth ordering (Finding 1 r2): a replayed fast-fail
    // already holds a queue slot — depth is irrelevant to it. It must resolve
    // the existing doc, never take the overflow branch and strand `replaying`.
    if (item.meta?.outageReplay) {
      await outage.store
        .release(item.id, agentId, "pending")
        .catch((err) => log.error("Outage replay pending-release failed", { error: String(err) }));
      log.info("Outage replay fast-failed again — back to pending, attempts unchanged", {
        provider,
        agentId,
      });
      return true;
    }

    try {
      const depth = await outage.store.pendingCount();
      if (depth >= outage.config.maxDepth) {
        // §5-2f: honest about the drop — drop-oldest would silently break
        // promises already made to other threads.
        log.error("Outage queue at max depth — turn NOT queued", {
          depth,
          maxDepth: outage.config.maxDepth,
          agentId,
          provider,
        });
        // Advisory 3 (plan review round 1): one overflow notice per thread
        // per episode, not one per overflowed message — a chatty outage with
        // a full queue would otherwise cost one SMS per dropped message.
        // Reuses the episode tracker's synchronous test-and-set with a
        // suffixed adapter key so this dedup key never collides with the
        // queued-turn notice's own key on the same thread/episode.
        if (
          policy === "notify" &&
          outage.episodes.firstForThread(provider, `${adapterKeyFor(item)}:overflow`, threadKeyFor(item))
        ) {
          await this.deliverOutageNotice(item, agentId, adapter, overflowNoticeFor(item.source.kind));
        }
        return true;
      }

      await outage.store.enqueue({ itemId: item.id, agentId, provider, workItem: item, policy });
    } catch (storeErr) {
      log.error("Outage enqueue failed — falling back to legacy error path", { error: String(storeErr) });
      return false;
    }

    if (policy === "notify" && outage.episodes.firstForThread(provider, adapterKeyFor(item), threadKeyFor(item))) {
      await this.deliverOutageNotice(item, agentId, adapter, outageNoticeFor(item.source.kind));
      log.info("Outage notice delivered", {
        agentId,
        provider,
        adapterKey: adapterKeyFor(item),
        threadKey: threadKeyFor(item),
      });
      outage.store.markNoticeSent(item.id, agentId).catch(() => {});
    } else if (policy === "silent") {
      log.info("Outage turn queued silently (system one-shot)", { agentId, provider });
    }
    return true;
  }

  /**
   * §5-2g "real failure" row: replay errored while the breaker is closed —
   * attempts+1; terminal `failed` at maxReplayAttempts delivers a plain-text
   * notice on notify policy (Finding 6 r1: the normal error path sets
   * `result.error`, which SMS/iMessage silently skip). Silent-policy items
   * fail without a notice, consistent with their enqueue-time silence.
   */
  private async resolveReplayRealFailure(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    error: string,
  ): Promise<void> {
    const outage = this.outage;
    if (!outage) return;
    const { terminal, doc } = await outage.store.recordFailedAttempt(
      item.id,
      agentId,
      error,
      outage.config.maxReplayAttempts,
    );
    log.error("Outage replay attempt failed (breaker closed)", {
      agentId,
      attempts: doc?.attempts,
      terminal,
    });
    if (terminal && doc?.policy === "notify") {
      await this.deliverOutageNotice(item, agentId, adapter, terminalFailureNotice(doc.enqueuedAt));
    }
  }

  /** Success bookkeeping: replay → done; episode-end gate (Finding 3 r1). */
  private async recordTurnSuccess(item: WorkItem, agentId: string): Promise<void> {
    const outage = this.outage;
    if (!outage) return;
    if (item.meta?.outageReplay) {
      await outage.store
        .release(item.id, agentId, "done")
        .catch((err) => log.error("Outage replay done-release failed", { error: String(err) }));
    }
    const provider = this.agentManager.providerFor(agentId);
    if (provider && outage.episodes.hasActiveEpisode(provider)) {
      const snapshot = this.agentManager.circuitBreakers.stateFor(provider);
      if (snapshot?.state !== "open") {
        outage.episodes.clear(provider);
        log.info("Outage episode ended — provider recovered", { provider });
      }
    }
  }

  /**
   * Plain-text outage notice: `error` deliberately UNSET so every adapter
   * actually delivers it (`result.error` → formatError on Slack, delivery
   * SKIP on SMS/iMessage, raw Error frame on WS — zero adapter changes).
   * Delivery failure → existing retry queue, like any message. Public: the
   * replay processor uses it for batched expiry notices.
   */
  async deliverOutageNotice(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    text: string,
  ): Promise<void> {
    const target = adapter ?? this.adapters.get(item.source.adapterId ?? item.source.kind);
    if (!target) {
      log.warn("Outage notice has no adapter — dropped", { agentId, source: item.source.kind });
      return;
    }
    const notice: WorkResult = { text, agentId, workItem: item, costUsd: 0, durationMs: 0 };
    try {
      await target.deliver(notice);
    } catch (err) {
      log.warn("Outage notice delivery failed, queuing for retry", { error: String(err) });
      this.retryQueue?.enqueue(notice, target);
    }
  }

  /**
   * KPR-223: voice per-turn routing. The voice adapter cannot emit through
   * `onWorkItem` (synchronous HTTP request/response with Vapi requires
   * writing the response in the same call), so the dispatcher exposes this
   * direct entry point. Applies taskLedger + audit log; **skips dedup** —
   * voice WorkItem.id is the Vapi callId, which is reused across many turns
   * within a single call, and adding callId to the dedup map would silently
   * drop turns 2+ inside the 60s TTL. Voice is implicitly serialized by
   * Vapi (one POST per turn).
   */
  async routeVoiceTurn(ctx: TurnContext, onStream?: SpawnTurnStreamCallback): Promise<TurnResult> {
    // No dedup — Q4 invariant. See class comment above.
    const tracked = this.taskLedger?.shouldTrack(ctx.workItem) ?? false;
    if (tracked) {
      this.taskLedger!.onDispatch(ctx.workItem, ctx.agentId).catch((err) =>
        log.warn("Task ledger dispatch failed (voice)", { error: String(err) }),
      );
    }

    const result = await this.agentManager.spawnTurn(ctx, onStream);

    if (tracked) {
      const workResult: WorkResult = {
        text: result.finalMessage,
        agentId: ctx.agentId,
        workItem: ctx.workItem,
        costUsd: result.usage.costUsd,
        durationMs: result.usage.durationMs,
        error: result.errors[0],
      };
      this.taskLedger!.onComplete(workResult).catch((err) =>
        log.warn("Task ledger complete failed (voice)", { error: String(err) }),
      );
    }

    if (this.auditAdapter && ctx.workItem.source.kind !== this.auditAdapter.kind) {
      const workResult: WorkResult = {
        text: result.finalMessage,
        agentId: ctx.agentId,
        workItem: ctx.workItem,
        costUsd: result.usage.costUsd,
        durationMs: result.usage.durationMs,
        error: result.errors[0],
      };
      this.postAuditLog(workResult).catch((err) => log.warn("Audit post failed (voice)", { error: String(err) }));
    }

    return result;
  }

  private async resolveAgents(item: WorkItem): Promise<ResolvedAgent[]> {
    // 0. Explicit target — callbacks and internal routing specify exact agent
    //    Always returns single agent, even in multi-agent threads
    const targetAgentId = item.meta?.targetAgentId as string | undefined;
    if (targetAgentId && this.registry.get(targetAgentId)) {
      return [{ agentId: targetAgentId }];
    }

    // 0.5 Team routing — DMs resolve to channel member, channels use @mention
    if (item.source.kind === "team") {
      return this.resolveFromTeam(item);
    }

    // 0.6 Origin routing — single-purpose apps declare identity via connect-time tag
    //     Must run before channel/thread/name so shop-floor messages can't accidentally
    //     land on an agent whose name appears in the text.
    const origin = item.meta?.origin as string | undefined;
    if (origin) {
      const match = this.registry.findByOrigin(origin);
      if (match) {
        return [{ agentId: match.id }];
      }
      log.warn("Origin not routed", {
        origin,
        deviceId: item.meta?.deviceId as string | undefined,
        text: item.text.slice(0, 50),
      });
      return [];
    }

    // 0.7 Conference channel — meeting mode with classifier-gated fan-out
    if (item.source.kind === "slack" && item.source.label.startsWith("conf-")) {
      return this.resolveConferenceAgents(item);
    }

    // 1. Dedicated channel mapping — always route to channel owner
    //    Prevents name collisions (e.g. customer "Jasper" routing to agent Jasper in #agent-jessica)
    //    Note: conf-* channels are intercepted above (step 0.7) before this check
    const channelAgent = this.registry.findByChannel(item.source.label);
    if (channelAgent) return [{ agentId: channelAgent.id }];

    // 2. Thread participant resolution — scan for new mentions in existing threads
    if (item.threadId) {
      const newMentions = this.registry.findAllByName(item.text);
      const newMentionIds = new Set(newMentions.map((a) => a.id));

      // 2a. Existing multi-agent thread — add any new mentions
      const existingParticipants = this.threadParticipants.get(item.threadId);
      if (existingParticipants) {
        for (const id of newMentionIds) existingParticipants.add(id);
        this.threadAgentLastSeen.set(item.threadId, Date.now());
        return [...existingParticipants].map((agentId) => ({ agentId }));
      }

      // 2b. Existing single-agent thread — check for single→multi transition
      const existing = this.threadAgentMap.get(item.threadId);
      if (existing) {
        // If new mentions include agents beyond the current one, transition to multi-agent
        const hasNewAgents = newMentions.some((a) => a.id !== existing);
        if (newMentionIds.size > 0 && hasNewAgents) {
          const participants = new Set([existing, ...newMentionIds]);
          this.threadParticipants.set(item.threadId, participants);
          this.threadAgentMap.delete(item.threadId);
          this.threadAgentLastSeen.set(item.threadId, Date.now());
          log.info("Thread transitioned to multi-agent", {
            threadId: item.threadId,
            participants: [...participants],
          });
          return [...participants].map((agentId) => ({ agentId }));
        }
        // Single-agent continuity (unchanged behavior)
        this.threadAgentLastSeen.set(item.threadId, Date.now());
        return [{ agentId: existing }];
      }

      // 2c. No in-memory affinity — check persisted sessions (survives restart)
      const persisted = await this.agentManager.findAgentsForThread(item.threadId);
      if (persisted.length > 0) {
        const validAgents = persisted.filter((id) => this.registry.get(id));
        if (validAgents.length > 1) {
          const participants = new Set(validAgents);
          this.threadParticipants.set(item.threadId, participants);
          this.threadAgentLastSeen.set(item.threadId, Date.now());
          return [...participants].map((agentId) => ({ agentId }));
        }
        if (validAgents.length === 1) {
          this.threadAgentMap.set(item.threadId, validAgents[0]);
          this.threadAgentLastSeen.set(item.threadId, Date.now());
          return [{ agentId: validAgents[0] }];
        }
      }
    }

    // 3. Name addressing — works in shared channels ("hey Jasper", "@Jasper", "Jasper, ...")
    //    May return multiple agents if several are mentioned in the same message
    const allNamed = this.registry.findAllByName(item.text);
    if (allNamed.length > 0) {
      return allNamed.map((a) => ({ agentId: a.id }));
    }

    // 4. Adapter-specific default (e.g. DMs to Jasper's bot → vp-engineering)
    const adapterDefault = item.meta?.defaultAgentId as string | undefined;
    if (adapterDefault && this.registry.get(adapterDefault)) return [{ agentId: adapterDefault }];

    // 5. Keyword match — disabled (too many false positives in shared channels)
    // const keyword = this.registry.findByKeyword(item.text);
    // if (keyword) return [{ agentId: keyword.id }];

    // 6. DM fallback — Slack DMs (channel id starts with "D") and Team DMs should
    //    always land on the default agent when nothing else claims them. Without this,
    //    first-contact DMs silently drop because no agent has the ad-hoc channel in its
    //    `channels` array.
    if (this.isDirectMessage(item) && this.registry.get(this.defaultAgentId)) {
      log.info("DM routed to default agent", {
        agentId: this.defaultAgentId,
        channel: item.source.id,
      });
      return [{ agentId: this.defaultAgentId }];
    }

    // 7. No match — drop unless it's a dedicated channel or DM
    //    Agents must be explicitly addressed (name mention, dedicated channel, thread continuity, or DM)
    log.debug("No agent matched — dropping", { channel: item.source.label });
    return [];
  }

  /**
   * Detect DMs across supported channel kinds.
   *   - Slack DMs: source.id starts with "D"
   *   - Team DMs: meta.channelType === "im" OR source.id starts with "dm:"
   */
  private isDirectMessage(item: WorkItem): boolean {
    if (item.source.kind === "slack" && item.source.id.startsWith("D")) return true;
    if (item.meta?.channelType === "im") return true;
    if (item.source.kind === "team" && typeof item.source.id === "string" && item.source.id.startsWith("dm:"))
      return true;
    return false;
  }

  private async resolveFromTeam(item: WorkItem): Promise<{ agentId: string }[]> {
    const channelId = item.meta?.channelId as string | undefined;
    if (!channelId || !this.teamStore) {
      // Fall back to default agent
      const defaultId = item.meta?.defaultAgentId as string | undefined;
      if (defaultId && this.registry.get(defaultId)) return [{ agentId: defaultId }];
      return [];
    }

    const channel = await this.teamStore.getChannel(channelId);
    if (!channel) {
      log.warn("Team channel not found", { channelId });
      return [];
    }

    // DMs — route to the other member (the agent)
    if (channel.type === "dm") {
      const agentId = channel.members.find((m) => m !== item.sender);
      if (agentId && this.registry.get(agentId)) {
        return [{ agentId }];
      }
      log.warn("DM agent not found in registry", { channelId, members: channel.members });
      return [];
    }

    // Channels — check for @mentions first
    const mentioned = this.registry.findAllByName(item.text);
    if (mentioned.length > 0) {
      // Only include agents that are members of this channel
      const channelMembers = new Set(channel.members);
      const validMentions = mentioned.filter((a) => channelMembers.has(a.id));
      if (validMentions.length > 0) {
        return validMentions.map((a) => ({ agentId: a.id }));
      }
    }

    // No mention — route to first agent member of the channel (lightweight default)
    const agentMembers = channel.members.filter((m) => this.registry.get(m));
    if (agentMembers.length > 0) {
      return [{ agentId: agentMembers[0] }];
    }

    log.warn("No agent members in Team channel", { channelId });
    return [];
  }

  /** Dispatch a single work item to a single agent (used for fan-out) */
  private async dispatchToAgent(item: WorkItem, resolved: ResolvedAgent): Promise<void> {
    const { agentId } = resolved;

    // Conference mode: inject thread context + preamble into the WorkItem
    let effectiveItem = item;
    if (resolved.conferenceMode) {
      const contextPrefix = [resolved.meetingPreamble, "", resolved.threadContext, "", "---", `[New message]:`]
        .filter(Boolean)
        .join("\n");
      effectiveItem = {
        ...item,
        text: `${contextPrefix}\n${item.text}`,
        meta: {
          ...item.meta,
          conferenceMode: true,
          conferenceHumanTs: resolved.conferenceHumanTs,
          conferenceRound: resolved.conferenceRound,
        },
      };
    }

    const threadId = effectiveItem.threadId ?? effectiveItem.id;
    // Refresh TTL for multi-agent threads (affinity already set by resolveAgents)
    this.threadAgentLastSeen.set(threadId, Date.now());

    const tracked = this.taskLedger?.shouldTrack(effectiveItem) ?? false;
    if (tracked) {
      this.taskLedger!.onDispatch(effectiveItem, agentId).catch((err) =>
        log.warn("Task ledger dispatch failed", { error: String(err) }),
      );
    }

    const adapter = this.adapters.get(effectiveItem.source.adapterId ?? effectiveItem.source.kind);

    try {
      const runResult = this.convertTurnResult(await this.agentManager.runWorkItemTurn(agentId, effectiveItem));

      // KPR-307: same post-turn outage gate + replay-failure gate as the
      // single-dispatch path — the fan-out body is a near-duplicate.
      if (await this.maybeHandlePostTurnOutage(effectiveItem, agentId, adapter, runResult)) {
        return;
      }
      if (this.outage && effectiveItem.meta?.outageReplay && runResult.error) {
        await this.resolveReplayRealFailure(effectiveItem, agentId, adapter, runResult.error);
        return;
      }

      const trimmedText = runResult.text.trim();
      const isNonResponse = NON_RESPONSE_PATTERNS.some((p) => p.test(trimmedText));

      if (isNonResponse) {
        log.info("Non-response suppressed (fan-out)", { agentId });
      } else {
        const workResult: WorkResult = {
          text: runResult.text || "_No response._",
          agentId,
          workItem: effectiveItem,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
          error: runResult.error,
        };
        await this.deliverAgentResult(workResult, adapter);

        // Conference mode: trigger depth-1 peer reactions
        if (resolved.conferenceMode && resolved.conferenceRound === 0 && !isNonResponse) {
          this.triggerConferenceReactions(runResult.text, item, agentId, resolved.conferenceHumanTs!).catch((err) =>
            log.warn("Conference reaction trigger failed", {
              error: String(err),
            }),
          );
        }

        if (tracked) {
          this.taskLedger!.onComplete(workResult).catch((err) =>
            log.warn("Task ledger complete failed", { error: String(err) }),
          );
        }
        if (this.auditAdapter && effectiveItem.source.kind !== this.auditAdapter.kind) {
          await this.postAuditLog(workResult);
        }
        log.info("Fan-out dispatch complete", {
          agentId,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
        });
      }

      // KPR-307: success bookkeeping (replay → done; episode-end gate).
      if (!runResult.error) {
        await this.recordTurnSuccess(effectiveItem, agentId);
      }
    } catch (err) {
      await this.handleTurnFailure(err, effectiveItem, agentId, adapter);
    }
  }

  sweep(threadTtlMs: number): SweepResult {
    const cutoff = Date.now() - threadTtlMs;
    let pruned = 0;
    for (const [id, ts] of this.threadAgentLastSeen) {
      if (ts < cutoff) {
        this.threadAgentMap.delete(id);
        this.threadParticipants.delete(id);
        this.meetingRosters.delete(id);
        this.meetingReactionTracker.delete(id);
        this.threadAgentLastSeen.delete(id);
        pruned++;
      }
    }
    return { component: "dispatcher", pruned, retried: 0, bytesFreed: 0, errors: [] };
  }

  private async resolveConferenceAgents(item: WorkItem): Promise<ResolvedAgent[]> {
    const threadId = item.threadId ?? item.id;

    // Build/update roster from name mentions
    const roster = this.meetingRosters.get(threadId) ?? new Set<string>();
    const newMentions = this.registry.findAllByName(item.text);
    for (const agent of newMentions) {
      roster.add(agent.id);
    }
    this.meetingRosters.set(threadId, roster);
    this.threadAgentLastSeen.set(threadId, Date.now());

    if (roster.size === 0) {
      log.debug("Conference channel — no roster yet", {
        channel: item.source.label,
        threadId,
      });
      return [];
    }

    // Build roster member list for classifier
    const rosterMembers: RosterMember[] = [];
    for (const agentId of roster) {
      const agent = this.registry.get(agentId);
      if (!agent || agent.disabled) continue;
      rosterMembers.push({
        agentId: agent.id,
        name: agent.name,
        title: agent.title,
        role: agent.soul.split("\n")[0], // first line of soul as role summary
      });
    }

    if (rosterMembers.length === 0) {
      return [];
    }

    // Fetch thread context for injection and classifier recency
    let threadContext = "";
    let recentMessages = "";
    if (this.slackAdapter) {
      const channelId = item.source.id;
      const threadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string) ?? threadId;
      const history = await this.slackAdapter.fetchThreadHistory(channelId, threadTs);
      threadContext = this.formatThreadContext(history, item.source.label, rosterMembers);
      // Last 5 messages for classifier recency context
      recentMessages = history
        .slice(-5)
        .map((m) => `${m.author}: ${m.text.slice(0, 200)}`)
        .join("\n");
    }

    // Run classifier
    const classification = await classifyMeetingMessage(item.text, rosterMembers, recentMessages);

    log.info("Conference classifier result", {
      channel: item.source.label,
      threadId,
      roster: [...roster],
      selected: classification.respondAgentIds,
      costUsd: classification.costUsd,
    });

    const preamble = this.buildMeetingPreamble(item.source.label, rosterMembers);

    return classification.respondAgentIds.map((agentId) => ({
      agentId,
      conferenceMode: true,
      conferenceHumanTs: item.meta?.slackTs as string,
      conferenceRound: 0,
      threadContext,
      meetingPreamble: preamble,
    }));
  }

  private formatThreadContext(history: ThreadMessage[], channelName: string, roster: RosterMember[]): string {
    if (history.length === 0) return "";

    const participantNames = roster.map((r) => r.name).join(", ");
    const header = `[Meeting thread in #${channelName} — participants: ${participantNames}]`;

    // If thread is very long, include first 5 + last 100 messages
    let messages = history;
    if (history.length > 105) {
      const first = history.slice(0, 5);
      const last = history.slice(-100);
      messages = [...first, ...last];
    }

    const formatted = messages
      .map((m) => {
        const ago = this.formatTimeAgo(m.timestamp);
        return `${m.author} (${ago}): ${m.text}`;
      })
      .join("\n");

    return `${header}\n\n${formatted}`;
  }

  private formatTimeAgo(timestamp: Date): string {
    const seconds = Math.floor((Date.now() - timestamp.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }

  private buildMeetingPreamble(channelName: string, roster: RosterMember[]): string {
    const names = roster.map((r) => r.name).join(", ");
    return `You are in a meeting in #${channelName} with ${names}.

Meeting rules:
- Be concise — others are also responding.
- Build on what's been said. Don't repeat points already made.
- If you have nothing meaningful to add, respond with "No response needed."
- Stay in your lane — don't cover someone else's domain unless asked.
- Address others by name when responding to their points.`;
  }

  private async triggerConferenceReactions(
    responseText: string,
    originalItem: WorkItem,
    respondingAgentId: string,
    humanTs: string,
  ): Promise<void> {
    const threadId = originalItem.threadId ?? originalItem.id;

    const roster = this.meetingRosters.get(threadId);
    if (!roster) return;

    // Get or create reaction tracker for this thread + human message
    if (!this.meetingReactionTracker.has(threadId)) {
      this.meetingReactionTracker.set(threadId, new Map());
    }
    const threadTracker = this.meetingReactionTracker.get(threadId)!;
    const reacted = threadTracker.get(humanTs) ?? new Set<string>();
    threadTracker.set(humanTs, reacted);

    // Build roster of peers who haven't reacted yet.
    // IMPORTANT: Claim peers in `reacted` synchronously BEFORE the async classifier call
    // to prevent concurrent round-0 responders from double-triggering the same peer.
    const peerMembers: RosterMember[] = [];
    for (const agentId of roster) {
      if (agentId === respondingAgentId) continue;
      if (reacted.has(agentId)) continue;
      const agent = this.registry.get(agentId);
      if (!agent || agent.disabled) continue;
      reacted.add(agentId); // claim before await — prevents race with concurrent calls
      peerMembers.push({
        agentId: agent.id,
        name: agent.name,
        title: agent.title,
        role: agent.soul.split("\n")[0],
      });
    }

    if (peerMembers.length === 0) return;

    // Classify which peers should react to this response
    const classification = await classifyMeetingMessage(responseText, peerMembers);

    // Release peers that weren't selected — they can still be triggered by other round-0 responders
    const selectedSet = new Set(classification.respondAgentIds);
    for (const member of peerMembers) {
      if (!selectedSet.has(member.agentId)) {
        reacted.delete(member.agentId);
      }
    }

    if (classification.respondAgentIds.length === 0) return;

    log.info("Conference depth-1 reactions", {
      threadId,
      respondingAgent: respondingAgentId,
      peers: classification.respondAgentIds,
    });

    // Re-fetch thread context (now includes the round-0 response)
    let threadContext = "";
    let preamble = "";
    if (this.slackAdapter) {
      const channelId = originalItem.source.id;
      const threadTs =
        (originalItem.meta?.slackThreadTs as string) ?? (originalItem.meta?.slackTs as string) ?? threadId;
      const history = await this.slackAdapter.fetchThreadHistory(channelId, threadTs);
      const allRosterMembers: RosterMember[] = [];
      for (const agentId of roster) {
        const agent = this.registry.get(agentId);
        if (!agent || agent.disabled) continue;
        allRosterMembers.push({
          agentId: agent.id,
          name: agent.name,
          title: agent.title,
          role: agent.soul.split("\n")[0],
        });
      }
      threadContext = this.formatThreadContext(history, originalItem.source.label, allRosterMembers);
      preamble = this.buildMeetingPreamble(originalItem.source.label, allRosterMembers);
    }

    // Dispatch reactions concurrently (peers already claimed in reacted set above)
    const reactionDispatches = classification.respondAgentIds.map((agentId) => {
      const resolved: ResolvedAgent = {
        agentId,
        conferenceMode: true,
        conferenceHumanTs: humanTs,
        conferenceRound: 1,
        threadContext,
        meetingPreamble: preamble,
      };
      return this.dispatchToAgent(originalItem, resolved);
    });

    await Promise.all(reactionDispatches);
  }

  private async postAuditLog(result: WorkResult): Promise<void> {
    if (!this.auditAdapter || !this.auditChannelIds) return;

    const agentConfig = this.registry.get(result.agentId);
    const agentName = agentConfig?.name ?? result.agentId;
    const homeBase = agentConfig?.homeBase;
    const channelId = (homeBase ? this.auditChannelIds.get(homeBase) : undefined) ?? this.fallbackAuditChannelId;
    if (!channelId) {
      log.warn("No audit channel resolved for agent", {
        agentId: result.agentId,
        homeBase,
      });
      return;
    }
    // Skip if the audit would post back into the same channel the message came from.
    if (result.workItem.source.kind === "slack" && result.workItem.source.id === channelId) {
      return;
    }
    const icon =
      result.workItem.source.kind === "sms"
        ? ":phone:"
        : result.workItem.source.kind === "imessage"
          ? ":speech_balloon:"
          : result.workItem.source.kind === "app"
            ? ":iphone:"
            : ":incoming_envelope:";
    const senderDisplay = result.workItem.senderName ?? result.workItem.sender;
    const summary = result.text.length > 300 ? result.text.slice(0, 300) + "..." : result.text;

    const auditItem: WorkItem = {
      id: `audit:${result.workItem.id}`,
      text: `${icon} *${agentName}* handled ${result.workItem.source.kind} from ${senderDisplay}:\n> ${summary}\n_($${result.costUsd.toFixed(3)} \u00b7 ${(result.durationMs / 1000).toFixed(1)}s)_`,
      source: { kind: "internal", id: channelId, label: "audit" },
      sender: "system",
      timestamp: new Date(),
      // Preserve thread info from original message so audit logs are threaded
      meta: {
        slackThreadTs: result.workItem.meta?.slackThreadTs as string,
        slackTs: result.workItem.meta?.slackTs as string,
      },
    };

    await this.auditAdapter.deliver({
      text: auditItem.text,
      agentId: "system",
      workItem: auditItem,
      costUsd: 0,
      durationMs: 0,
    });
  }
}
