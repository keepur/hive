import { createLogger } from "../logging/logger.js";
import type { WorkItem, WorkResult } from "../types/work-item.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import { isBroadcastCapable } from "./channel-adapter.js";
import {
  conferenceRoundOf,
  type AgentManager,
  type TurnContext,
  type TurnResult,
  type SpawnTurnStreamCallback,
} from "../agents/agent-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { HealthReporter } from "../health/health-reporter.js";
import type { TaskLedger } from "../tasks/task-ledger.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import type { RetryQueue } from "../sweeper/retry-queue.js";
import type { SlackAdapter, ThreadMessage } from "./slack-adapter.js";
import type { MeetingScribe, MeetingSummary } from "../workers/meeting-scribe.js";
import type { RunResult } from "../agents/agent-runner.js";
import { classifyMeetingMessage, type RosterMember } from "../agents/meeting-classifier.js";
import { ProviderCircuitOpenError } from "../agents/provider-circuit-breaker.js";
import { classifyTurnResult, HARD_FAULT_KINDS } from "../agents/provider-adapters/error-classification.js";
import type { OutageQueueStore, OutageQueueConfig, OutageEnqueueOrigin } from "../outage/outage-queue-store.js";
import {
  OutageEpisodeTracker,
  adapterKeyFor,
  outageNoticeFor,
  overflowNoticeFor,
  policyFor,
  terminalFailureNotice,
  threadKeyFor,
} from "../outage/outage-notices.js";
import {
  MAX_DEADLINE_CONTINUATIONS,
  deadlineBaseIdOf,
  deadlineContinuationWrap,
  deadlineNoticeFor,
  deadlineTerminalNoticeFor,
  deadlineZeroProgressNoticeFor,
} from "./deadline-continuation.js";

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

/** KPR-388: max of raw Slack ts strings by numeric value; undefined when none present. */
function maxSlackTs(candidates: Array<string | undefined>): string | undefined {
  let best: string | undefined;
  for (const ts of candidates) {
    if (!ts) continue;
    if (best === undefined || parseFloat(ts) > parseFloat(best)) best = ts;
  }
  return best;
}

/** Extended resolved-agent type carrying optional conference metadata */
interface ResolvedAgent {
  agentId: string;
  conferenceMode?: boolean;
  conferenceHumanTs?: string;
  conferenceRound?: number; // 0 = human-triggered, 1 = peer reaction
  threadContext?: string;
  meetingPreamble?: string;
  /** Round-1 only: the peer reply this reaction turn should engage with (KPR-387). */
  reactionTo?: { authorName: string; text: string };
  /** KPR-388: how threadContext was assembled — full transcript or delta since the mark. */
  injectionMode?: "full" | "delta" | "summary";
  /** KPR-388: max Slack ts (raw string) covered by this turn's injection; the mark advances to it on success. */
  injectionHighWaterTs?: string;
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
  /** KPR-409: optional running-summary source for the full-arm anchor.
   *  Absent ⇒ every conference path behaves exactly as pre-KPR-409. */
  private meetingScribe?: MeetingScribe;
  private meetingRosters = new Map<string, Set<string>>(); // threadId → agent IDs
  // Map<threadId, Map<humanMessageTs, Set<agentId>>> — agents excluded from
  // reacting on this human message, either round (KPR-387). Round-0 primaries
  // are recorded at DELIVERY time (KPR-416 — markReactionExclusion, three call
  // sites; supersedes KPR-386 canon C1's selection-time recording, so a
  // SUPPRESSED primary is no longer excluded), round-1 reactors at claim time
  // (triggerConferenceReactions). Shape, keying and TTL are unchanged (C2).
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

  setMeetingScribe(scribe: MeetingScribe): void {
    this.meetingScribe = scribe;
  }

  async dispatch(item: WorkItem): Promise<void> {
    // 0. Deduplicate — if two adapters see the same Slack message, only process it once.
    //    KPR-307: outage replays are engine-authored redispatches of the ORIGINAL
    //    item id (no synthetic per-attempt id — Finding 1 r1: §5-2g doesn't count
    //    fast-fails, so a synthetic id would repeat and dedup would silently drop
    //    every replay after the first). Dedup exists for externally-duplicated
    //    deliveries; a replay has nothing to dedup against — bypass it.
    //    KPR-402 (r1 SF-1): continuation legs are engine-authored on the same
    //    rationale, and they NEED the bypass — under multi-agent fan-out /
    //    conference every agent's leg derives the SAME id (`<origin>#dl<n>`:
    //    the counter is per-chain, not per-agent), so id-only dedup would
    //    silently drop agent 2's leg at debug level after its notice already
    //    promised a continuation. A leg, like a replay, has nothing to dedup
    //    against — its (agentId, id) pair is what's unique, and every
    //    downstream store write is already keyed on the composite.
    if (this.recentMessageIds.has(item.id) && !item.meta?.outageReplay && item.meta?.deadlineRetry === undefined) {
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

      // KPR-389 D5b: single-dispatch leg of the round-1 kill suppression —
      // reachable only by replayed reactions (live conference turns always
      // route via dispatchToAgent). Discriminator is the meta (replay
      // `resolved` carries no conference fields). Delivery-only suppression:
      // recordTurnSuccess below still runs, so replay → done resolution is
      // unharmed. Text-bearing kills DELIVER here, unlike the fan-out leg —
      // replay is the last delivery chance. No error arm: an errored replay
      // already resolved via resolveReplayRealFailure above. Text-bearing
      // kills DELIVER (below) rather than staying silent — replay is the
      // last delivery chance — so the discriminator for bypassing the
      // deadline-abort arm (immediately below) is the broader
      // isRound1AbortedReplay, not killedReaction alone: BOTH the silent and
      // the text-bearing round-1 replay outcomes own their own resolution
      // here and must never be intercepted by the continuation-notice arm.
      const isRound1AbortedReplay = conferenceRoundOf(item) === 1 && (runResult.aborted || runResult.timedOut);
      const killedReaction = isRound1AbortedReplay && !trimmedText;

      // KPR-402: closed-circuit deadline-abort interception. Runs AFTER
      // maybeHandlePostTurnOutage (the zero-progress+open ★ row keeps the
      // outage path unchanged; the with-progress+open ★ row migrates from
      // bare legacy delivery to this arm — spec §Design.6 / ⚠A8), after the
      // replay-error gate (disjoint: a Claude-lane deadline abort never sets
      // error — the runner's deadline CLOSES the iterator), and — deliberately
      // — after the D5b computation above: a round-1 aborted/timed-out replay
      // owns its own resolution (silent drop or last-chance delivery, below)
      // and must never be intercepted by the continuation-notice arm.
      if (!isRound1AbortedReplay && (await this.maybeHandleDeadlineAbort(item, agentId, adapter, runResult))) {
        return;
      }

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
          // KPR-401: segmentation flags — log-based dashboards can now
          // exclude aborted/timed-out turns' honest zeros from spend and
          // latency stats. convertTurnResult already maps both faithfully.
          aborted: runResult.aborted,
          timedOut: runResult.timedOut,
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
      // KPR-388: fresh-vs-resumed signal consumed by the conference
      // meeting-mark bookkeeping in dispatchToAgent.
      resumedSession: turn.resumedSession,
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

    // The entire guard chain — provider probe, source/floorCritical checks, and
    // the broadcast — runs inside one try so that ANY synchronous throw (not
    // just a broadcast rejection) falls through to the normal source-adapter
    // path, honoring this method's documented "any failure ... falls through"
    // contract. This matters once KPR-306's real breaker state is wired into
    // outageStateProvider(): a throwing provider must never surface as a
    // "Something went wrong" error on an otherwise-successful agent turn.
    try {
      if (!this.outageStateProvider()) return false;
      const sourceKind = result.workItem.source.kind;
      if (sourceKind !== "slack" && sourceKind !== "scheduler") return false;
      if (this.registry.get(result.agentId)?.floorCritical !== true) return false;
      const wsAdapter = this.adapters.get("ws");
      if (!wsAdapter || !isBroadcastCapable(wsAdapter)) return false;

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
      log.warn("Outage diversion: guard/broadcast failed, falling through", {
        agentId: result.agentId,
        error: String(err),
      });
      return false;
    }
  }

  /**
   * KPR-416: mark reaction-exclusion at DELIVERY time. One rule —
   *
   *   an agent is excluded from reacting on a trigger iff its own round-0
   *   turn on that trigger handed text to delivery
   *
   * — implemented as one helper called from three sites (fan-out delivery,
   * single-dispatch delivery, handleTurnFailure's adapter arm) so the
   * invariant is auditable rather than emergent. "Handed to delivery", not
   * "was posted": the call sites sit immediately before the delivery call, so
   * a diverted (tryOutageDiversion) or adapter-less delivery still marks —
   * the turn ran and consumed the trigger (spec §4).
   *
   * Keyed on `meta.meetingExclusionTs`, stamped round-0-only in
   * dispatchToAgent's conference meta block. That key rides item.meta, so it
   * reaches every delivery path for free: the outage-queued document, every
   * KPR-402 continuation leg (whose construction strips the four `conference*`
   * keys but not this one — deliberately named outside that family), and both
   * handleTurnFailure legs. Engine-authored notices (KPR-307 outage, KPR-402
   * first-abort/terminal, replay-terminal) never reach a call site and so
   * never mark: they are engine chrome, not agent content.
   *
   * Synchronous and idempotent (Set add). Tracker shape, keying and TTL are
   * unchanged — KPR-386 canon C2 preserved, C1 superseded.
   * Spec: docs/epics/kpr-415/kpr-416-spec.md §5.3.
   */
  private markReactionExclusion(item: WorkItem, agentId: string): void {
    const ts = item.meta?.meetingExclusionTs;
    // Type-guarded, not cast: meta is Record<string, unknown> and this helper
    // sits on the hot path of every single-dispatch turn in the engine, where
    // the key is absent. Anything that is not a non-empty string is a no-op.
    if (typeof ts !== "string" || ts.length === 0) return;
    const threadId = item.threadId ?? item.id;
    if (!this.meetingReactionTracker.has(threadId)) {
      this.meetingReactionTracker.set(threadId, new Map());
    }
    const threadTracker = this.meetingReactionTracker.get(threadId)!;
    const responded = threadTracker.get(ts) ?? new Set<string>();
    responded.add(agentId);
    threadTracker.set(ts, responded);
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
        // KPR-400 (F2): the turn never ran — fast-fail class (replays first).
        const handled = await this.handleOutageTurn(item, agentId, adapter, err.provider, "fast-fail");
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
   * the provider's breaker is open. Fires only when the FULL RunResult
   * classifies into HARD_FAULT_KINDS (KPR-398: the classifier consults
   * toolCalls/streamed/text inside its timedOut && aborted rule — a
   * zero-progress hang classifies hard `timeout` and queues here; a
   * with-progress deadline abort classifies breaker-inconclusive
   * `turn-deadline` and follows the LEGACY path, because it by definition
   * executed tools or streamed and a partially-executed tool turn's side
   * effects must not be silently re-run — the same Finding 4 r1 rationale
   * that keeps `non-provider` classifications out of the queue). The former
   * redundant `timedOut && aborted` hangTimeout arm is deleted: rule 1
   * classifies that shape as a fault irrespective of `error`, so hardFault
   * alone covers exactly what it caught; the Finding 3 r2 concern (runner-
   * deadline timeouts leave `error` unset, so `errors` alone never fires)
   * lives in the cheap-exit condition below, which still admits error-less
   * timedOut turns. Gated on snapshot.enabled so shadow mode stays fully
   * observational.
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

    // KPR-398: full RunResult — structurally carries toolCalls/streamed/text.
    const classification = classifyTurnResult(runResult);
    const hardFault = classification.outcome === "fault" && HARD_FAULT_KINDS.has(classification.kind);
    if (!hardFault) return false;

    // KPR-400 (F2): the turn RAN and hard-faulted with the breaker open —
    // post-turn-fault class (deadline burners live here; replays last).
    return this.handleOutageTurn(item, agentId, adapter, provider, "post-turn-fault");
  }

  /**
   * KPR-402: deadline-abort continuation arm. Matches the D6 rows 1-2 shape
   * only (`timedOut && aborted` — the Claude-lane/Lane-A deadline abort):
   * Lane B's sentinel carries `aborted: false` and operator stops carry no
   * `timedOut`, so neither ever enters. NOT outage machinery (⚠A6): active
   * regardless of `outageQueue.enabled` — the replay-doc branches simply
   * never fire when `this.outage` is unset (no replays exist then).
   *
   * With progress (D6 kind `turn-deadline` — the KPR-399-persisted session
   * exists): honest first-abort notice on notify channels, then an
   * IN-PROCESS re-dispatch of a synthetic continuation item whose session
   * resumes through the unchanged runWorkItemTurn → sessionStore.get path
   * (emergent, zero new code — and dependent on the thread-key pin below).
   * Bounded chain: MAX_DEADLINE_CONTINUATIONS, then a terminal notice
   * naming the manual "continue" hatch. Zero progress (hard `timeout` — the
   * hang signature): notice only / warn-log only, never a re-dispatch.
   * Cron: fully inert. The breaker never sees this arm — the aborted leg's
   * record-once (inconclusive `turn-deadline`) already happened in the
   * manager, and the arm adds no record site.
   *
   * Returns true when the turn was fully handled (notice and/or re-dispatch
   * and/or replay-doc resolution); false = fall through to normal delivery.
   */
  private async maybeHandleDeadlineAbort(
    item: WorkItem,
    agentId: string,
    adapter: ChannelAdapter | undefined,
    runResult: RunResult,
  ): Promise<boolean> {
    if (runResult.timedOut !== true || runResult.aborted !== true) return false;
    const policy = policyFor(item);
    if (policy === "skip") return false; // cron: re-fires at next match — arm fully inert (ticket ruling)

    // D6 single source of truth — full RunResult through classifyTurnResult
    // (the KPR-398 call-site convention), never a re-implemented predicate.
    // (`outcome === "fault"` is the discriminant narrowing the union before
    // `.kind` — the same two-step the KPR-398 hard-fault gate above uses.)
    const classification = classifyTurnResult(runResult);
    const withProgress = classification.outcome === "fault" && classification.kind === "turn-deadline";

    if (!withProgress) {
      // Zero progress (hard `timeout`): NEVER a re-dispatch (⚠A3) — nothing
      // was persisted to resume (D1 fail-closed persist gate), a fresh
      // restart would re-run the full turn against a provider that just sat
      // silent for the entire deadline, and repeat hangs are the breaker's
      // designed territory (three consecutive open the circuit and the
      // KPR-307 queue+notice machinery takes over with its own honest story).
      if (this.outage && item.meta?.outageReplay) {
        // §5-2g "real failure while breaker closed": attempts+1, pending
        // again (silent — the enqueue-time outage notice's promise still
        // stands) or terminal `failed` with the existing terminal notice.
        // No separate deadline notice — never double-notice one thread.
        await this.resolveReplayRealFailure(item, agentId, adapter, "turn deadline exceeded (zero progress)");
        return true;
      }
      if (policy === "notify") {
        await this.deliverOutageNotice(item, agentId, adapter, deadlineZeroProgressNoticeFor(item.source.kind));
        // r1 NIT-1: the notify arm exits were the only two silent ones. Same
        // field shape as the silent twins' warns (no message text — KPR-307
        // redaction posture), plus the KPR-401 segmentation fields, since
        // "Work item dispatched" never fires for an arm-handled turn.
        log.info("Deadline zero-progress abort — notice delivered, no continuation", {
          agentId,
          itemId: item.id,
          threadId: item.threadId,
          deadlineRetry: item.meta?.deadlineRetry,
          timedOut: runResult.timedOut,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
          llmMs: runResult.llmMs,
          toolCalls: runResult.toolCalls,
        });
      } else {
        // Silent one-shot (callback:/event:/team-): warn log only — no
        // human is owed a notice (KPR-307 posture). The one-shot's trigger
        // is lost for this firing (accepted, spec §Design.3 r1 B2); the
        // warn keeps it conspicuous, and the bare "_No response._" delivery
        // to a system surface is suppressed too.
        log.warn("Deadline zero-progress abort on silent one-shot — dropped with log", {
          agentId,
          itemId: item.id,
        });
      }
      return true;
    }

    // ---- With progress: notice + in-process continuation ----

    // 1. Replay-doc resolution: the queue slot resolves; the chain owns the
    //    turn from here (⚠A5: a crash mid-chain loses only the continuation
    //    — the session row survives, so the thread's next message resumes
    //    the partial work; strictly better than today's done+"_No response._").
    if (this.outage && item.meta?.outageReplay) {
      await this.outage.store
        .release(item.id, agentId, "done", "deadline abort — continuation dispatched in-process (KPR-402)")
        .catch((err) => log.error("Deadline-abort replay done-release failed", { error: String(err) }));
    }

    // r1 NIT-2: fail CLOSED on a non-finite counter. A corrupted or
    // hand-edited `deadlineRetry` (NaN from a non-numeric value, Infinity)
    // would sail past `n >= MAX_DEADLINE_CONTINUATIONS` — NaN compares false
    // against everything — and dispatch an unbounded chain of `#dlNaN` legs.
    // Treat anything non-finite as at-cap: terminal notice, no leg.
    const rawRetry = Number(item.meta?.deadlineRetry ?? 0);
    const n = Number.isFinite(rawRetry) ? rawRetry : MAX_DEADLINE_CONTINUATIONS;

    // 2. Notice cadence: two per chain, maximum — one first-abort notice
    //    (deadlineRetry absent), silence on intermediate legs, one terminal
    //    notice at the cap. No episode-tracker involvement (deadline aborts
    //    are discrete per-thread events, not provider episodes).
    if (policy === "notify" && item.meta?.deadlineRetry === undefined) {
      await this.deliverOutageNotice(item, agentId, adapter, deadlineNoticeFor(item.source.kind));
    }

    // 3. Cap check (G3): the counter strictly increments and nothing resets
    //    or strips it; the terminal notice's manual hatch is real — the
    //    KPR-399 session row persists either way.
    if (n >= MAX_DEADLINE_CONTINUATIONS) {
      if (policy === "notify") {
        await this.deliverOutageNotice(item, agentId, adapter, deadlineTerminalNoticeFor(item.source.kind));
        log.info("Deadline continuation cap exhausted — terminal notice delivered", {
          agentId,
          itemId: item.id,
          threadId: item.threadId,
          deadlineRetry: item.meta?.deadlineRetry,
          timedOut: runResult.timedOut,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
          llmMs: runResult.llmMs,
          toolCalls: runResult.toolCalls,
        });
      } else {
        log.warn("Deadline continuation cap exhausted on silent one-shot", { agentId, itemId: item.id });
      }
      return true;
    }

    // 4. Re-dispatch — AFTER the notice delivery completed (the adapter
    //    round-trip also puts real time between finalize's fire-and-forget
    //    session write and the continuation's store read — belt, ⚠A4).
    //
    // META HYGIENE (spec r1 B1): replay markers must NOT leak into the
    // chain. The processor stamps `outageReplay: true` on every replayItem,
    // and the dispatcher's three replay branches (resolveReplayRealFailure,
    // handleOutageTurn's release-before-depth, handleTurnFailure's
    // pending-release) key on that flag with store filters of {itemId,
    // agentId} and NO status guard — an inherited flag would let a
    // continuation leg's later failure resurrect the origin's resolved
    // `done` doc back to pending (duplicate replay of the ORIGINAL stored
    // workItem). Strip on EVERY leg construction: a fresh-seeded chain
    // acquires the flag after one queue round-trip. Everything else in meta
    // passes through unchanged (blocklist, not allowlist — channel keys
    // like slackThreadTs are load-bearing for routing and delivery).
    //
    // KPR-413: conference keys are stripped alongside the replay marker. A
    // continuation leg computed no injection and never re-enters conference
    // resolution (targetAgentId routes it through resolveAgents step 0,
    // which precedes the conf-* check at step 0.7), so inheriting
    // conferenceMode/Round/HumanTs/InjectionMode would stamp a
    // non-conference turn as a conference turn with an injection mode it
    // never used — corrupting both C18 measurement surfaces
    // (agent_turn_telemetry, activity_log). Same shape as C26's `worker:`
    // re-entry: an engine-authored re-dispatch into a meeting thread is an
    // ordinary turn. This deliberately reverses KPR-402's own stated
    // rationale (kpr-402-spec.md:359-362) that conference keys are
    // load-bearing for routing — verified false for this codebase: routing
    // is targetAgentId, not any conference meta key. Still a blocklist, not
    // an allowlist — channel keys stay.
    const {
      outageReplay: _replayMarker,
      conferenceMode: _confMode,
      conferenceRound: _confRound,
      conferenceHumanTs: _confHumanTs,
      conferenceInjectionMode: _confInjectionMode,
      ...carriedMeta
    } = item.meta ?? {};
    const baseId = deadlineBaseIdOf(item.id); // leg ids stay flat: x#dl3, never x#dl1#dl2#dl3 (⚠A11)
    const originalText =
      typeof item.meta?.deadlineOriginalText === "string" ? item.meta.deadlineOriginalText : item.text;
    const retryItem: WorkItem = {
      ...item,
      // Per-leg id (⚠A11): a chain leg's own outage enqueue (breaker opens
      // mid-chain) writes under a FRESH (itemId, agentId) key — a real
      // $setOnInsert insert beside the origin's terminal doc that serializes
      // the leg's workItem (counter included) verbatim, never a silent
      // same-key no-op. Suffixing keeps policyFor's prefix classes intact
      // (callback:x#dl1 is still callback:-classed). Dedup: a leg's id is
      // first-seen on the SINGLE-agent path, but fan-out mints the same leg
      // id once per aborting agent, so dedup carries a deadlineRetry bypass
      // for engine-authored legs (D39 / child-PR r1 SF-1, pinned T16).
      id: `${baseId}#dl${n + 1}`,
      // THREAD-KEY PINNING (spec r2 blocker): every threadId consumer falls
      // back to item.id when threadId is absent — runWorkItemTurn's session
      // read (agent-manager.ts:866), the per-thread lock, threadAgentMap,
      // the task ledger. For threadId-less items (callback:/bg:/ct:/
      // meeting: completions) the origin leg persisted its session under
      // key `x` while an unpinned continuation would READ under `x#dl1`:
      // no resume, ever — the blind fresh re-run Finding-4 forbids.
      // Materialize the origin's EFFECTIVE thread key before the id changes;
      // threaded items are unaffected (identity copy).
      threadId: item.threadId ?? item.id,
      text: deadlineContinuationWrap(originalText, n + 1, MAX_DEADLINE_CONTINUATIONS + 1),
      meta: {
        ...carriedMeta,
        targetAgentId: agentId, // resolveAgents step 0 — routed exactly like a replay, no re-resolution drift
        deadlineRetry: n + 1,
        // Wrap round-trip (T9): a later leg wraps the ORIGINAL request, never
        // a previous leg's wrap nested.
        deadlineOriginalText: originalText,
      },
    };
    // Fire-and-forget: awaiting would hold the caller (an adapter handler or
    // the replay drain) for another full deadline. onProcessingEnd fires for
    // the aborted leg; the continuation's own dispatch restarts the typing
    // indicator. The replay drain's statusOf re-read sees `done` (step 1)
    // and keeps draining — never the "no outcome recorded" defensive revert.
    void this.dispatch(retryItem).catch((err) =>
      log.error("Deadline continuation dispatch failed", { agentId, error: String(err) }),
    );
    log.info("Deadline continuation dispatched in-process", {
      agentId,
      itemId: retryItem.id,
      threadId: retryItem.threadId,
      deadlineRetry: n + 1,
      timedOut: runResult.timedOut,
      // KPR-401 log-segmentation parity: "Work item dispatched" never fires
      // for an arm-handled turn, so the aborted leg's spend/latency would
      // otherwise vanish from log-based dashboards entirely.
      costUsd: runResult.costUsd,
      durationMs: runResult.durationMs,
      llmMs: runResult.llmMs,
      toolCalls: runResult.toolCalls,
    });
    return true;
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
    /** KPR-400 (F2): enqueue class — threaded from the exactly two callers;
     *  $setOnInsert-immutable, so a replayed doc's re-visit here (the
     *  release-before-depth branch) never rewrites it. */
    origin: OutageEnqueueOrigin,
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

      await outage.store.enqueue({
        itemId: item.id,
        agentId,
        provider,
        workItem: item,
        policy,
        enqueueOrigin: origin,
        // KPR-403: enqueue-time deadline stamp — the doc carries its own
        // replay-turn wall-clock upper bound (D20 semantics) so the store's
        // recovery sweep needs no registry access. Both origin callers flow
        // through this single site; the replayed-fast-fail release branch
        // above never writes the field ($setOnInsert-immutable, spec ⚠A3).
        deadlineMs: this.agentManager.turnDeadlineUpperBoundMs(agentId),
      });
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
      // Belt-and-suspenders: dedicated channel ownership always beats thread affinity.
      // Step 1 above already checks this, but thread routing must never override a
      // channel's registered owner — re-check here so a label mismatch or any other
      // edge case in step 1 can't silently hand the message to the wrong agent.
      const dedicatedOwner = this.registry.findByChannel(item.source.label);
      if (dedicatedOwner) return [{ agentId: dedicatedOwner.id }];

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
      // KPR-387: round-1 reaction turns are framed against the peer reply — the
      // original human message is never re-presented in the terminal slot. It
      // remains reachable via session ∪ injected context (KPR-388 generalizes
      // the old re-fetched-transcript guarantee): a round-1 reactor was never a
      // round-0 responder for this trigger (C1/C2), so its mark predates the
      // triggering message — the message is in its delta, or already in its
      // session by the covering invariant. A reactor with no session/mark gets
      // the full transcript directly.
      const newMessageSegment = resolved.reactionTo
        ? `[${resolved.reactionTo.authorName} just replied]:\n${resolved.reactionTo.text}\n\n` +
          `React to ${resolved.reactionTo.authorName}'s reply if you have something to add. ` +
          `Do not re-answer the original question. If you have nothing to add, respond with "No response needed."`
        : `[New message]:\n${item.text}`;
      const contextPrefix = [resolved.meetingPreamble, resolved.threadContext, "---"].filter(Boolean).join("\n");
      // KPR-413: the transcript belongs to the MEETING, not to this turn. A
      // KPR-402 continuation leg re-wraps meta.deadlineOriginalText verbatim
      // on every leg (up to MAX_DEADLINE_CONTINUATIONS), into a session that
      // KPR-399 resume already loaded with the original composite — so
      // letting the arm fall back to item.text (the assembled composite,
      // preamble + full/delta/summary transcript + terminal slot) reproduces
      // the N-copies bloat this epic exists to remove. Stamp the turn's OWN
      // frame instead: preamble + terminal slot, no injection. Byte-shaped
      // exactly like an empty-delta turn (C10), and it rides into the
      // outage store so a replayed conference turn's later abort is honest
      // too (single-dispatch leg).
      const framePrefix = [resolved.meetingPreamble, "---"].filter(Boolean).join("\n");
      effectiveItem = {
        ...item,
        text: `${contextPrefix}\n${newMessageSegment}`,
        meta: {
          ...item.meta,
          conferenceMode: true,
          conferenceHumanTs: resolved.conferenceHumanTs,
          conferenceRound: resolved.conferenceRound,
          // KPR-389 D1: injection mode rides along so telemetry can segment
          // full vs delta turns (KPR-388 efficacy measurement).
          conferenceInjectionMode: resolved.injectionMode,
          deadlineOriginalText: `${framePrefix}\n${newMessageSegment}`,
          // KPR-416: the exclusion key rides the item so every delivery path
          // can mark reaction-exclusion uniformly — including the KPR-402
          // continuation chain, which deliberately strips the four conference
          // keys (see maybeHandleDeadlineAbort's leg construction). Named
          // OUTSIDE the `conference*` family on purpose: it must survive that
          // blocklist, and nothing telemetric reads it (verified: there is no
          // meta allowlist anywhere, and neither agent_turn_telemetry nor
          // activity_log spreads item.meta), so KPR-413's rationale — never
          // stamp a non-conference turn as a conference turn — is untouched.
          //
          // Round-0 only: a round-1 reactor's exclusion is claimed by
          // triggerConferenceReactions at dispatch, not by delivery. Guarded
          // on conferenceHumanTs because it is optional on ResolvedAgent (a
          // non-Slack conference surface has no ts to key on) — the same
          // guard the deleted selection-time write applied.
          ...(resolved.conferenceRound === 0 && resolved.conferenceHumanTs
            ? { meetingExclusionTs: resolved.conferenceHumanTs }
            : {}),
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

      // KPR-389 D5: a killed reaction is silent — never post filler into the
      // meeting, and never routed through the KPR-402 deadline-continuation
      // notice/re-dispatch machinery below (a round-1 reactor's timeout is
      // always a quiet drop, not a "your turn is continuing" notice — this
      // must run BEFORE maybeHandleDeadlineAbort). Keys on the in-memory
      // ResolvedAgent (replay items never carry conference fields here — they
      // take the single-dispatch leg, D5b). The early return deliberately
      // skips recordTurnSuccess: a killed turn is not evidence of provider
      // recovery (the KPR-307 episode ends on the next genuinely successful
      // turn). An errored reaction WITH text still delivers (exit-code-1
      // convention — may be a real answer + warning).
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

      // KPR-402: same deadline-abort arm as the single-dispatch path — the
      // fan-out body is a near-duplicate (same placement discipline as
      // maybeHandlePostTurnOutage above). Runs AFTER the D5 round-1 kill
      // check above (round-1 owns its own silent-drop semantics; this arm is
      // for round-0 / non-conference fan-out recipients).
      if (await this.maybeHandleDeadlineAbort(effectiveItem, agentId, adapter, runResult)) {
        return;
      }

      // KPR-388: meeting-continuity mark bookkeeping. Sits AFTER the outage,
      // deadline-abort, and D5 kill gates (a queued/fast-failed/
      // deadline-continued/killed turn must not touch the mark) and OUTSIDE
      // the isNonResponse branch below — a suppressed turn consumed its
      // injection all the same (C2's "responded or selected" spirit).
      // Error/aborted turns leave the mark untouched: session absorption is
      // unknown, and a stale-low mark only over-includes next turn
      // (duplication, never a gap — covering invariant, spec §5). Both store
      // methods are withRetry fail-soft and never throw.
      if (resolved.conferenceMode && !runResult.error && !runResult.aborted) {
        const sessionStore = this.agentManager.getSessionStore();
        if (resolved.injectionMode === "delta" && runResult.resumedSession === false) {
          // Delta went into a fresh session — continuity broke after
          // injection was baked. Clear the mark: the NEXT turn injects the
          // full transcript and heals (same-turn re-injection is impossible
          // by construction — retries reuse the already-shaped prompt).
          await sessionStore.clearMeetingMark(agentId, threadId);
        } else if (resolved.injectionHighWaterTs) {
          await sessionStore.setMeetingMark(agentId, threadId, resolved.injectionHighWaterTs);
        }
      }

      const trimmedText = runResult.text.trim();
      const isNonResponse = NON_RESPONSE_PATTERNS.some((p) => p.test(trimmedText));

      if (isNonResponse) {
        log.info("Non-response suppressed (fan-out)", { agentId, conferenceRound: resolved.conferenceRound });
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

    // Fetch thread history once per trigger — per-agent injection contexts
    // (full vs delta, KPR-388) are derived from it after classification.
    let history: ThreadMessage[] = [];
    let recentMessages = "";
    if (this.slackAdapter) {
      const channelId = item.source.id;
      const threadTs = (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string) ?? threadId;
      history = await this.slackAdapter.fetchThreadHistory(channelId, threadTs);
      // Last 5 messages for classifier recency context
      recentMessages = history
        .slice(-5)
        .map((m) => `${m.author}: ${m.text.slice(0, 200)}`)
        .join("\n");
    }

    // KPR-409 (R1 — requested C26 relaxation): round-level cadence trigger.
    // Fires once per round-0 pass INCLUDING passes where the classifier
    // selects nobody. Fire-and-forget: noteActivity returns void, never
    // throws, and removing this hunk restores byte-identical behavior.
    // (`rosterMembers.length > 0` is redundant with the :1565 early return —
    // kept deliberately so the seam states its own precondition locally and
    // survives any future reordering. Not a bug; do not "simplify" it away.)
    //
    // The try/catch makes the fail-open STRUCTURAL at this boundary rather than
    // dependent on the callee's internals holding (KPR-390 canon C27, same bug
    // shape as the getSummary call site). noteActivity's ASYNC portion is
    // already self-contained (`void this.run().catch().finally()`), but its
    // SYNCHRONOUS gate checks run on this stack — a throw there would propagate
    // straight through conference dispatch and kill the turn, contradicting the
    // spec's "the scribe never blocks a conference turn" requirement.
    if (history.length > 0 && rosterMembers.length > 0) {
      try {
        this.meetingScribe?.noteActivity({
          threadId,
          history,
          channelLabel: item.source.label,
          roster: rosterMembers,
          baseAgentId: rosterMembers[0].agentId,
          source: {
            adapterId: item.source.adapterId ?? item.source.kind,
            channelId: item.source.id,
            channelKind: item.source.kind,
            slackTs: (item.meta?.slackTs as string) ?? "",
            slackThreadTs: (item.meta?.slackThreadTs as string) ?? (item.meta?.slackTs as string) ?? threadId,
          },
        });
      } catch (err) {
        log.warn("Conference cadence: round-0 noteActivity threw, continuing the turn", {
          agentId: rosterMembers[0].agentId,
          threadId,
          error: String(err),
        });
      }
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

    // KPR-387: record round-0 responders so the reaction pass never re-selects a
    // primary for the same triggering human message. Recorded at selection time —
    // a primary whose turn errors or is suppressed stays excluded for this trigger
    // (deliberate: kills the suppressed-turn burn; Gate 1 delegated assumption).
    // Runs synchronously before any round-0 dispatch starts, so there is no race
    // with a fast round-0 completion triggering the reaction pass.
    const humanTs = item.meta?.slackTs as string | undefined;
    if (humanTs && classification.respondAgentIds.length > 0) {
      if (!this.meetingReactionTracker.has(threadId)) {
        this.meetingReactionTracker.set(threadId, new Map());
      }
      const threadTracker = this.meetingReactionTracker.get(threadId)!;
      const responded = threadTracker.get(humanTs) ?? new Set<string>();
      for (const id of classification.respondAgentIds) responded.add(id);
      threadTracker.set(humanTs, responded);
    }

    const preamble = this.buildMeetingPreamble(item.source.label, rosterMembers);

    // KPR-388: per-agent injection context — delta for agents with meeting
    // continuity, full transcript otherwise. Round-0 maxes the trigger's own
    // ts into the high-water mark (BOTH modes): the terminal slot presents
    // the trigger, so the session absorbs it even when the fetch raced it.
    return Promise.all(
      classification.respondAgentIds.map(async (agentId): Promise<ResolvedAgent> => {
        const injection = await this.buildConferenceContext(
          agentId,
          threadId,
          history,
          item.source.label,
          rosterMembers,
          humanTs,
        );
        return {
          agentId,
          conferenceMode: true,
          conferenceHumanTs: humanTs,
          conferenceRound: 0,
          threadContext: injection.threadContext,
          meetingPreamble: preamble,
          injectionMode: injection.injectionMode,
          injectionHighWaterTs: injection.injectionHighWaterTs,
        };
      }),
    );
  }

  private formatThreadContext(history: ThreadMessage[], channelName: string, roster: RosterMember[]): string {
    if (history.length === 0) return "";

    const participantNames = roster.map((r) => r.name).join(", ");
    const header = `[Meeting thread in #${channelName} — participants: ${participantNames}]`;

    const formatted = this.truncateHistory(history)
      .map((m) => {
        const ago = this.formatTimeAgo(m.timestamp);
        return `${m.author} (${ago}): ${m.text}`;
      })
      .join("\n");

    return `${header}\n\n${formatted}`;
  }

  /** If thread is very long, include first 5 + last 100 messages (KPR-388: shared with the high-water calc). */
  private truncateHistory(history: ThreadMessage[]): ThreadMessage[] {
    if (history.length <= 105) return history;
    return [...history.slice(0, 5), ...history.slice(-100)];
  }

  /**
   * KPR-388: per-agent conference injection context. Delta iff ALL hold:
   * the stored ref has a resumable sessionId (excludes no-row, TTL'd,
   * scrubbed, empty-handle/codex rows), the stored provider matches the
   * agent's current provider (else spawnTurn's KPR-313 guard runs the turn
   * fresh with a handoff notice — full injection is the correct pairing),
   * and a meeting mark exists. Every miss ⇒ full transcript, byte-identical
   * to the pre-KPR-388 shared context (C6 pin).
   */
  private async buildConferenceContext(
    agentId: string,
    threadId: string,
    history: ThreadMessage[],
    channelName: string,
    roster: RosterMember[],
    roundZeroTriggerTs?: string,
  ): Promise<{ threadContext: string; injectionMode: "full" | "delta" | "summary"; injectionHighWaterTs?: string }> {
    const ref = await this.agentManager.getSessionStore().get(agentId, threadId);
    const provider = this.agentManager.providerFor(agentId);
    if (!ref?.sessionId || !ref.meetingLastSeenTs || ref.provider !== provider) {
      // KPR-409 (C13-sanctioned anchor): a running summary replaces the raw
      // transcript for fresh-session entrants. Fail-soft by construction —
      // getSummary returns undefined when the scribe is absent, disabled, or
      // has nothing yet, in which case the full arm below is byte-identical to
      // pre-KPR-409 (C6 pin).
      //
      // The try/catch makes that fail-open STRUCTURAL at this boundary rather
      // than dependent on the callee's internals holding (KPR-390 canon C27,
      // same bug shape as the worker-claim-dedup call site): getSummary is
      // documented total, but a future edit that breaks the total-guarantee
      // must degrade to the full arm — a throw or rejection here would
      // otherwise propagate through resolveAgents and kill the entire
      // conference turn, contradicting the spec's "the scribe never blocks a
      // conference turn" requirement.
      let summary: MeetingSummary | undefined;
      try {
        summary = await this.meetingScribe?.getSummary(threadId);
      } catch (err) {
        log.warn("Conference anchor: getSummary failed, falling back to the full transcript", {
          agentId,
          error: String(err),
        });
      }
      if (summary) {
        const coveredNum = parseFloat(summary.coveredThroughTs);
        // Same 100-cap as truncateHistory's tail; no first-5 pin — the summary
        // holds the thread opening (the delta arm's own reasoning).
        const tail = history.filter((m) => parseFloat(m.ts) > coveredNum).slice(-100);
        return {
          threadContext: this.formatSummaryContext(summary.summaryText, tail, channelName, roster),
          injectionMode: "summary",
          // ⚠ R2 (requested relaxation, spec §D4). If the coherence reviewer
          // rules F1 instead, the reversal is to delete THIS ENTIRE
          // injectionHighWaterTs property — not just the coveredThroughTs term
          // below. Dropping only that term still leaves a defined mark on every
          // round-0 turn (the trigger ts) and every non-empty-tail turn (the
          // tail max), which is the withdrawn "max in only when the tail is
          // non-empty" variant, not F1. True F1 = no injectionHighWaterTs key
          // at all ⇒ undefined ⇒ the else-if at :1462 never calls
          // setMeetingMark on any summary turn, inverting five tests (both
          // T2(a) cases, T2(b), T2(c), T5) — see the plan header.
          injectionHighWaterTs: maxSlackTs([
            ...tail.map((m) => m.ts),
            // REQUIRED under R2, not cosmetic: without this term an empty tail
            // at round 1 yields undefined, setMeetingMark is skipped, and the
            // agent never converts to delta.
            summary.coveredThroughTs,
            roundZeroTriggerTs,
          ]),
        };
      }
      return {
        threadContext: this.formatThreadContext(history, channelName, roster),
        injectionMode: "full",
        injectionHighWaterTs: maxSlackTs([...this.truncateHistory(history).map((m) => m.ts), roundZeroTriggerTs]),
      };
    }

    const markNum = parseFloat(ref.meetingLastSeenTs);
    // Strictly greater than the mark; same 100-cap as truncateHistory's tail.
    // No first-5 pin — the session already holds the thread opening (covering
    // invariant, spec §5). An empty delta yields threadContext "" — dropped by
    // dispatchToAgent's filter(Boolean) join; the terminal slot still carries
    // the trigger (round-0) or peer reply (round-1), so it is always safe.
    const delta = history.filter((m) => parseFloat(m.ts) > markNum).slice(-100);
    return {
      threadContext: delta.length > 0 ? this.formatDeltaContext(delta, channelName, roster) : "",
      injectionMode: "delta",
      injectionHighWaterTs: maxSlackTs([...delta.map((m) => m.ts), roundZeroTriggerTs]),
    };
  }

  /**
   * KPR-388: delta-mode context — same header and body format as
   * formatThreadContext, headed as a delta. MUST NOT contain the
   * terminal-slot marker "[New message]:" (the C3 framing test's negative
   * assertions depend on its absence).
   */
  private formatDeltaContext(delta: ThreadMessage[], channelName: string, roster: RosterMember[]): string {
    const participantNames = roster.map((r) => r.name).join(", ");
    const header = `[Meeting thread in #${channelName} — participants: ${participantNames}]`;
    const formatted = delta
      .map((m) => {
        const ago = this.formatTimeAgo(m.timestamp);
        return `${m.author} (${ago}): ${m.text}`;
      })
      .join("\n");
    return `${header}\n[New messages since your last turn:]\n\n${formatted}`;
  }

  /**
   * KPR-409: summary-mode context — running summary plus the messages that
   * postdate it. Marker-collision checked (C3/C10): neither marker is
   * "[New message]:" (the terminal slot) nor "[New messages since your last
   * turn:]" (the delta header), and neither starts with "[New".
   * The tail block is omitted entirely when `tail` is empty.
   */
  private formatSummaryContext(
    summaryText: string,
    tail: ThreadMessage[],
    channelName: string,
    roster: RosterMember[],
  ): string {
    const participantNames = roster.map((r) => r.name).join(", ");
    const header = `[Meeting thread in #${channelName} — participants: ${participantNames}]`;
    const base = `${header}\n[Running summary of the meeting so far:]\n\n${summaryText}`;
    if (tail.length === 0) return base;
    const formatted = tail.map((m) => `${m.author} (${this.formatTimeAgo(m.timestamp)}): ${m.text}`).join("\n");
    return `${base}\n\n[Messages since the summary:]\n\n${formatted}`;
  }

  private formatTimeAgo(timestamp: Date): string {
    const seconds = Math.floor((Date.now() - timestamp.getTime()) / 1000);
    if (seconds < 60) return `${seconds}s ago`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.floor(minutes / 60);
    return `${hours}h ago`;
  }

  /** KPR-389 D4: hardened — the transcript is already in prompt ∪ session
   *  (C10 covering-invariant phrasing, true in full, delta, AND summary modes
   *  — KPR-409's summary mode substitutes a running summary for the raw
   *  transcript in the prompt, see formatSummaryContext); decline
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

    // Re-fetch thread history (now includes the round-0 response); per-reactor
    // injection contexts (full vs delta, KPR-388) are derived from it below.
    let history: ThreadMessage[] = [];
    const allRosterMembers: RosterMember[] = [];
    let preamble = "";
    if (this.slackAdapter) {
      const channelId = originalItem.source.id;
      const threadTs =
        (originalItem.meta?.slackThreadTs as string) ?? (originalItem.meta?.slackTs as string) ?? threadId;
      history = await this.slackAdapter.fetchThreadHistory(channelId, threadTs);
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
      preamble = this.buildMeetingPreamble(originalItem.source.label, allRosterMembers);
    }

    // KPR-409 (R1 — requested C26 relaxation): round-1 cadence trigger.
    // Selection-gated by construction (the three early returns above precede
    // the re-fetch). Same fire-and-forget contract — and the same structural
    // call-site fail-safety (KPR-390 canon C27) — as the round-0 seam: a throw
    // out of noteActivity's synchronous gate checks must never take down the
    // reaction dispatch below.
    if (history.length > 0 && allRosterMembers.length > 0) {
      try {
        this.meetingScribe?.noteActivity({
          threadId,
          history,
          channelLabel: originalItem.source.label,
          roster: allRosterMembers,
          baseAgentId: allRosterMembers[0].agentId,
          source: {
            adapterId: originalItem.source.adapterId ?? originalItem.source.kind,
            channelId: originalItem.source.id,
            channelKind: originalItem.source.kind,
            slackTs: humanTs,
            slackThreadTs:
              (originalItem.meta?.slackThreadTs as string) ?? (originalItem.meta?.slackTs as string) ?? threadId,
          },
        });
      } catch (err) {
        log.warn("Conference cadence: round-1 noteActivity threw, continuing the turn", {
          agentId: allRosterMembers[0].agentId,
          threadId,
          error: String(err),
        });
      }
    }

    // Dispatch reactions concurrently (peers already claimed in reacted set above)
    const responderName = this.registry.get(respondingAgentId)?.name ?? respondingAgentId;
    const reactionDispatches = classification.respondAgentIds.map(async (agentId) => {
      // KPR-388: per-reactor full/delta decision. No trigger max-in on
      // round-1 — new content reaches the mark only via the re-fetched
      // transcript (the peer reply's ts is not knowable here).
      const injection = await this.buildConferenceContext(
        agentId,
        threadId,
        history,
        originalItem.source.label,
        allRosterMembers,
      );
      const resolved: ResolvedAgent = {
        agentId,
        conferenceMode: true,
        conferenceHumanTs: humanTs,
        conferenceRound: 1,
        threadContext: injection.threadContext,
        meetingPreamble: preamble,
        injectionMode: injection.injectionMode,
        injectionHighWaterTs: injection.injectionHighWaterTs,
        reactionTo: { authorName: responderName, text: responseText },
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
