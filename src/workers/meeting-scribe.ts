/**
 * KPR-409: the meeting scribe — a cheap, tool-less pool worker that maintains
 * one running summary per meeting thread in `meeting_summaries`, so a
 * fresh-session entrant gets `summary + tail` instead of the raw transcript.
 *
 * NOT a meeting participant: never in a roster, never a classifier candidate,
 * never a conference dispatch, no posting surface. Its turn runs through
 * MeetingWorkerPool.runRoleTurn — sessionless, lock-exempt, breaker-invisible,
 * not spawnBudget-accounted, and (unlike a fetch-worker) never registered in
 * the pool's liveWorkers, so it can never starve a boss's worker_dispatch.
 *
 * Never a correctness dependency: every failure, gate, and outage falls
 * through to today's byte-identical full-transcript injection.
 */
import type { Collection, Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { MeetingWorkersConfig } from "./worker-pool-config.js";
import type { RoleTurnOutcome, WorkerRoleParams } from "./meeting-worker-pool.js";

const log = createLogger("meeting-scribe");

/** Hard truncation on write. Deliberately ABOVE the charter's 2000-char soft
 *  instruction: the gap absorbs a small model's normal overshoot so the cap
 *  only ever fires on a genuinely runaway summary. Do NOT align the numbers. */
export const SUMMARY_TEXT_CAP = 2500;
const SUMMARIES_TTL_SECONDS = 7 * 86_400;

/** Structurally assignable from SlackAdapter's ThreadMessage — declared
 *  locally so src/workers/ stays free of a src/channels/ dependency (the
 *  worker-pool-config cycle-safety posture). */
export interface ScribeMessage {
  author: string;
  text: string;
  timestamp: Date;
  ts: string;
}

export interface MeetingSummaryDoc {
  _id: string; // threadId
  summaryText: string;
  coveredThroughTs: string;
  version: number;
  updatedAt: Date;
  updating?: { startedAt: Date };
}

/** What the dispatcher's anchor reads. */
export interface MeetingSummary {
  summaryText: string;
  coveredThroughTs: string;
}

/** Narrow pool surface — capabilities only (WorkerPoolManagerHooks posture).
 *  Mirrors runRoleTurn's seven-required workItemContext shape exactly. */
export interface ScribePoolSurface {
  runRoleTurn(args: {
    base: AgentConfig;
    role: WorkerRoleParams;
    prompt: string;
    workItemContext: {
      adapterId: string;
      channelId: string;
      channelKind: string;
      channelLabel: string;
      threadId: string;
      slackTs: string;
      slackThreadTs: string;
    };
    onAbortHandle?: (abort: () => void) => void;
  }): Promise<RoleTurnOutcome | null>;
  hasCapacity(): boolean;
}

export interface ScribeRegistry {
  get(id: string): AgentConfig | undefined;
}

export interface MeetingScribeDeps {
  db: Db;
  registry: ScribeRegistry;
  pool: ScribePoolSurface;
  config: MeetingWorkersConfig;
  now?: () => Date;
}

export interface NoteActivityArgs {
  threadId: string;
  history: ScribeMessage[];
  channelLabel: string;
  roster: Array<{ name: string }>;
  /** Config donor — any roster member of the triggering round. Re-resolved
   *  live at run time; budgetUsd therefore varies with the trigger (accepted). */
  baseAgentId: string;
  /** Real turn context from the triggering WorkItem — inert under
   *  coreServers: [] but honest, and correct if that ever widens. */
  source: {
    adapterId: string;
    channelId: string;
    channelKind: string;
    slackTs: string;
    slackThreadTs: string;
  };
}

/** Thrown out of the scribe's onAbortHandle callback when stop() has already
 *  latched. Exported so the test can pin the mechanism, not the prose. */
export const SCRIBE_STOPPED_ERROR = "meeting scribe stopped before turn start";

export class MeetingScribe {
  private readonly summaries: Collection<MeetingSummaryDoc>;
  private readonly inFlight = new Set<string>();
  private readonly abortHandles = new Map<string, () => void>();
  private readonly lastRunAt = new Map<string, number>();
  private readonly now: () => Date;
  private stopped = false;

  constructor(private readonly deps: MeetingScribeDeps) {
    this.summaries = deps.db.collection<MeetingSummaryDoc>("meeting_summaries");
    this.now = deps.now ?? (() => new Date());
  }

  /** TTL housekeeping only — no correctness role, so index.ts .catch-logs this
   *  rather than making it boot-fatal (deliberate divergence from the claim
   *  ledger's C27 posture; spec §Integration points issue 5). */
  async ensureIndexes(): Promise<void> {
    await this.summaries.createIndex({ updatedAt: 1 }, { expireAfterSeconds: SUMMARIES_TTL_SECONDS });
  }

  /** Fail-soft read for the dispatcher's full-arm anchor. Never throws. */
  async getSummary(threadId: string): Promise<MeetingSummary | undefined> {
    const cfg = this.deps.config;
    if (!cfg.enabled || !cfg.scribeEnabled) return undefined; // E10 — reverts the anchor immediately
    try {
      const doc = await this.summaries.findOne({ _id: threadId });
      // A doc carrying only { _id, updating } is a failed-first-run stub, not
      // a summary — both fields must be present or the anchor must not fire.
      if (!doc?.summaryText || !doc.coveredThroughTs) return undefined;
      return { summaryText: doc.summaryText, coveredThroughTs: doc.coveredThroughTs };
    } catch (err) {
      log.warn("Summary read failed — falling back to full injection", { error: String(err) });
      return undefined;
    }
  }

  /**
   * Cadence trigger. Returns void synchronously and NEVER throws — the two
   * conference seams are fire-and-forget, and removing them must restore
   * byte-identical behavior.
   *
   * ⚠ Gates 1/3/2a/5a are synchronous and sit ABOVE the claim; the claim is
   * taken before the first await (a round's Promise.all fan-out and
   * overlapping rounds both land in one tick). Do not reorder.
   */
  noteActivity(args: NoteActivityArgs): void {
    if (this.stopped) return; // gate 0 — shutdown latched; see stop()
    const cfg = this.deps.config;
    if (!cfg.enabled || !cfg.scribeEnabled) return; // gate 1
    const { threadId } = args;
    // ⚠ Gate 3 must distinguish "never run" from "ran too recently". A `?? 0`
    // sentinel conflates them: under any clock whose epoch is below
    // scribeDebounceMs (a fake `now` seam, or a genuinely fresh process on a
    // mocked clock), `now - 0 < 90_000` blocks the FIRST EVER run on every
    // thread — the scribe would silently never start, and every "no run"
    // gating test would pass for the wrong reason. Use an explicit
    // has-run-before check, never an arithmetic sentinel.
    const lastRun = this.lastRunAt.get(threadId);
    if (lastRun !== undefined && this.now().getTime() - lastRun < cfg.scribeDebounceMs) return; // gate 3
    if (this.inFlight.has(threadId)) return; // gate 2a — synchronous
    if (this.inFlight.size >= cfg.scribeMaxConcurrent) return; // gate 5a — synchronous
    this.inFlight.add(threadId); // claimed BEFORE any await
    void this.run(args)
      .catch((err) => log.warn("Scribe run failed — summary unchanged", { error: String(err) }))
      .finally(() => {
        // ⚠ ONE shared lifecycle: both maps are keyed on threadId and must be
        // released together on every path incl. throw and abort. Splitting
        // them leaks a handle per thread and leaves stop() aborting adapters
        // that completed long ago.
        this.inFlight.delete(threadId);
        this.abortHandles.delete(threadId);
      });
  }

  /** Aborts every live scribe run. Scribes are not in the pool's liveWorkers,
   *  so pool.stop()/abortForBoss deliberately do not reach them (spec §D3/E5). */
  stop(): void {
    this.stopped = true; // latch BEFORE the sweep — anything minted after this
    // point self-refuses at the onAbortHandle checkpoint
    for (const [threadId, abort] of this.abortHandles) {
      try {
        abort();
      } catch (err) {
        log.warn("Scribe abort threw during stop — contained", { threadId, error: String(err) });
      }
    }
  }

  private async run(args: NoteActivityArgs): Promise<void> {
    const cfg = this.deps.config;
    const { threadId } = args;

    const doc = await this.summaries.findOne({ _id: threadId }).catch((err) => {
      log.warn("Scribe summary read failed — abandoning this trigger", { error: String(err) });
      return null;
    });

    // Gate 2b — crash-leftover guard across restarts (the in-memory set is
    // empty after a restart; a stale `updating` older than 2x the wall clock
    // is overridden).
    const updatingAt = doc?.updating?.startedAt?.getTime();
    if (updatingAt !== undefined && this.now().getTime() - updatingAt < 2 * cfg.scribeTimeoutMs) return;

    // Gate 4 — novelty. First run: coveredThroughTs absent ⇒ every message
    // counts, so a meeting summarizes once it is scribeMinNewMessages deep.
    const coveredNum = parseFloat(doc?.coveredThroughTs ?? "0");
    const newMessages = args.history.filter((m) => parseFloat(m.ts) > coveredNum);
    if (newMessages.length < cfg.scribeMinNewMessages) return;

    // Gate 5b — one-directional yield: a busy pool means the engine is busy.
    if (!this.deps.pool.hasCapacity()) return;

    // E8 — live registry re-check (mirrors spawnFetchWorker's re-check).
    const base = this.deps.registry.get(args.baseAgentId);
    if (!base || base.disabled) return;

    if (this.stopped) return; // checkpoint 2 — shutdown began while this run awaited Mongo

    const startedAt = this.now();
    await this.summaries
      .updateOne({ _id: threadId }, { $set: { updating: { startedAt }, updatedAt: startedAt } }, { upsert: true })
      .catch((err) => log.warn("Scribe updating-flag write failed — proceeding", { error: String(err) }));

    try {
      const role: WorkerRoleParams = {
        model: cfg.scribeModel,
        coreServers: [], // C22 — the transcript is in the prompt; the scribe needs nothing
        maxTurns: cfg.scribeMaxTurns,
        timeoutMs: cfg.scribeTimeoutMs,
        charter: scribeCharter(args.channelLabel),
      };
      const outcome = await this.deps.pool.runRoleTurn({
        base,
        role,
        prompt: scribeTurnPrompt(args.channelLabel, args.roster, doc?.summaryText, newMessages, startedAt),
        workItemContext: {
          adapterId: args.source.adapterId,
          channelId: args.source.channelId,
          channelKind: args.source.channelKind,
          channelLabel: args.channelLabel,
          threadId,
          slackTs: args.source.slackTs,
          slackThreadTs: args.source.slackThreadTs,
        },
        onAbortHandle: (abort) => {
          // KPR-414 checkpoint 3. stop() makes a single synchronous pass over
          // abortHandles; a handle minted after that pass would be an orphan.
          //
          // ⚠ We THROW rather than calling `abort()`, and that is load-bearing,
          // not stylistic. runRoleTurn invokes this callback at
          // meeting-worker-pool.ts:600, one line BEFORE adapter.runTurn() at
          // :601 — and ClaudeAgentAdapter.abort() → AgentRunner.abort() is a
          // no-op while activeQuery is null, which it is until deep inside
          // send() (agent-runner.ts:2091). Calling abort() here would return
          // silently having done nothing, and the turn would run to completion
          // unaborted AND unregistered: strictly worse than today.
          //
          // The throw unwinds INSIDE runRoleTurn's single try (:591-623), so
          // adapter.runTurn() is never reached — nothing is spawned, so there
          // is nothing to abort — and its catch (:621-623) contains the throw
          // into a normal error-shaped RoleTurnOutcome, which run()'s existing
          // `outcome.error` branch already handles. runRoleTurn is byte-
          // untouched: onAbortHandle is OUR closure, and throwing from a
          // caller-supplied callback is inside its existing contract.
          if (this.stopped) throw new Error(SCRIBE_STOPPED_ERROR);
          this.abortHandles.set(threadId, abort);
        },
      });

      const text = outcome?.text?.trim();
      if (!outcome || outcome.error || outcome.timedOut || outcome.aborted || !text) {
        log.info("Scribe turn produced no summary — prior summary stands", {
          threadId,
          error: outcome?.error?.slice(0, 120),
          timedOut: outcome?.timedOut,
          aborted: outcome?.aborted,
        });
        return;
      }

      const coveredThroughTs = newMessages.reduce(
        (best, m) => (parseFloat(m.ts) > parseFloat(best) ? m.ts : best),
        doc?.coveredThroughTs ?? newMessages[0].ts,
      );
      await this.summaries.updateOne(
        { _id: threadId },
        {
          $set: {
            summaryText: text.slice(0, SUMMARY_TEXT_CAP),
            coveredThroughTs,
            updatedAt: this.now(),
          },
          $inc: { version: 1 },
          $unset: { updating: "" },
        },
        { upsert: true },
      );
      log.info("Scribe summary updated", {
        threadId,
        covered: newMessages.length,
        costUsd: outcome.costUsd,
        durationMs: outcome.durationMs,
      });
    } finally {
      // Clear `updating` on EVERY path (success already unset it; this covers
      // failure/timeout/abort/throw) and stamp the debounce for any attempted
      // turn — a persistently failing scribe must not re-run every round.
      await this.summaries
        .updateOne({ _id: threadId }, { $unset: { updating: "" }, $set: { updatedAt: this.now() } })
        .catch((err) => log.warn("Scribe updating-flag clear failed", { error: String(err) }));
      this.lastRunAt.set(threadId, this.now().getTime());
    }
  }
}

/** Exported for a byte pin. Total systemPromptOverride replacement — no soul,
 *  no constitution (voice/fetch-worker precedent). ⚠ The 2000 here is a SOFT
 *  instruction; SUMMARY_TEXT_CAP (2500) is the hard write-side truncation. The
 *  500-char headroom is deliberate — do not align them. */
export function scribeCharter(channelLabel: string): string {
  return `You are the scribe for a meeting in #${channelLabel}. You maintain one running
summary of the meeting for colleagues who join late.

Rewrite the summary below to incorporate the new messages. Return the COMPLETE
replacement summary — not a diff, not a preface, not a commentary.

Cover: decisions made, open questions, and each participant's current position.
Drop resolved chatter. Stay under 2000 characters.

You have no tools and no messaging surface. Your final message IS the summary.`;
}

/** Exported for a byte pin. Reuses the conference body shape
 *  (`Author (n min ago): text`) so the scribe reads the same transcript
 *  format the meeting agents do. */
export function scribeTurnPrompt(
  channelLabel: string,
  roster: Array<{ name: string }>,
  priorSummary: string | undefined,
  newMessages: ScribeMessage[],
  at: Date,
): string {
  const participants = roster.map((r) => r.name).join(", ");
  const body = newMessages.map((m) => `${m.author} (${formatTimeAgo(m.timestamp, at)}): ${m.text}`).join("\n");
  return (
    `Meeting: #${channelLabel}\n` +
    `Participants: ${participants}\n\n` +
    `CURRENT SUMMARY:\n${priorSummary ?? "(none yet — this is the first summary of this meeting.)"}\n\n` +
    `NEW MESSAGES:\n${body}`
  );
}

function formatTimeAgo(timestamp: Date, at: Date): string {
  const seconds = Math.floor((at.getTime() - timestamp.getTime()) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)}h ago`;
}
