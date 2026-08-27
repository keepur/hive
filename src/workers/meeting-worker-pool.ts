/**
 * KPR-390 (Part A): Meeting worker pool — async fetch-workers with a Mongo
 * claim ledger (`meeting_worker_claims`).
 *
 * A conference boss claims a task atomically (exact-key partial-unique index
 * + best-effort semantic dedup), a detached claude-lane worker runs it
 * (cloned boss config minus WORKER_SERVER_DENYLIST, sessionless,
 * breaker-invisible, NOT spawnBudget-accounted — bounds are the pool caps),
 * and completion re-enters the boss through the callback-shaped WorkItem via
 * the onDispatch seam (dispatcher step-0 pin).
 *
 * The scribe role (Part B) is KPR-409 — it will reuse runWorkerTurn with its
 * own WorkerRoleParams and zero changes to this file's spawn path.
 */
import { createHash } from "node:crypto";
import { ObjectId, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { WorkItem, ChannelKind } from "../types/work-item.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { AgentProviderAdapter } from "../agents/provider-adapters/types.js";
import type { CircuitBreakerSnapshot } from "../agents/provider-circuit-breaker.js";
import type { MeetingWorkersConfig } from "./worker-pool-config.js";
import { classifyClaimDedup } from "./worker-claim-dedup.js";

const log = createLogger("meeting-worker-pool");

/** Redaction rule (spec §A6): taskText previews hard-capped at 80 chars on
 *  EVERY log site; resultText is NEVER logged at any length (ledger-only). */
const TASK_PREVIEW_CHARS = 80;
const RESULT_TEXT_CAP = 8000;
const WATCHDOG_INTERVAL_MS = 60_000;
/** Housekeeping TTL — terminal docs age out; live expiry is the watchdog's
 *  status flip on `expiresAt`, so a TTL-deleted doc is always already terminal. */
const CLAIMS_TTL_SECONDS = 7 * 86_400;

/**
 * Through-the-boss + containment enforcement — STRUCTURAL, not prose
 * (code-enforce-don't-prose-enforce). Stripped from the worker's cloned
 * coreServers — AND paired with the runner's suppressAutoInjectedServers
 * worker-mode flag (set by the manager's buildWorkerAdapter): team/schedule/
 * team-roster are auto-injected for every normal agent regardless of
 * coreServers, so the strip alone would be a no-op without the flag.
 * Rationale per entry (spec §A3): outbound message surfaces
 * (slack/quo/resend/team/event-bus/recall/voice); self-scheduling &
 * re-entry minting (callback/schedule); recursion (worker-pool); agent-def
 * editing (admin); detached-process escape hatch that would outlive every
 * kill path (background — E5 load-bearing); credential-read leak
 * amplification (keychain); long-lived CLI session spawning (code-task).
 * Memory servers deliberately STAY (same trust domain, reviewer-confirmed r1).
 */
export const WORKER_SERVER_DENYLIST = new Set<string>([
  "slack",
  "quo",
  "resend",
  "team",
  "event-bus",
  "callback",
  "schedule",
  "recall",
  "voice",
  "admin",
  "worker-pool",
  "background",
  "keychain",
  "code-task",
]);

/** The WorkItemContext seven — per-turn metadata from the boss's dispatching turn. */
export interface WorkerPoolTurnContext {
  adapterId?: string;
  channelId?: string;
  channelKind?: string;
  channelLabel?: string;
  threadId?: string;
  slackTs?: string;
  slackThreadTs?: string;
}

export type WorkerClaimStatus = "running" | "done" | "failed" | "expired" | "cancelled";

export interface WorkerClaimSource {
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  slackTs: string;
  slackThreadTs: string;
}

export interface WorkerClaimDoc {
  _id: ObjectId;
  /** Meeting thread key — the boss turn's WorkItemContext.threadId (already the `threadId ?? id` formula). */
  threadId: string;
  /** Re-entry source snapshot (callback-doc template). */
  source: WorkerClaimSource;
  taskText: string;
  /** sha256 of lowercase/whitespace-collapsed taskText — exact-match atomicity key. */
  taskKey: string;
  status: WorkerClaimStatus;
  bossAgentId: string;
  workerModel: string;
  createdAt: Date;
  updatedAt: Date;
  /** createdAt + claimTtlMinutes — watchdog deadline, NOT a Mongo TTL delete. */
  expiresAt: Date;
  resultText?: string;
  error?: string;
  /** C18: the worker measurement surface. */
  durationMs?: number;
  costUsd?: number;
  toolCalls?: number;
  dedup?: { compared: number; verdict: "unique" | "duplicate"; costUsd: number };
}

/**
 * Per-role spawn parameters (spec §A3 plan directive): the fetch-worker role
 * is Part A's only instantiation; KPR-409's scribe supplies its own object
 * (haiku pin, coreServers: [], scribe caps/charter) with zero changes here.
 */
export interface WorkerRoleParams {
  model: string;
  /** POST-filter allowlist — the role owns the filtering (fetch role: boss minus denylist). */
  coreServers: string[];
  maxTurns: number;
  timeoutMs: number;
  /** Total systemPromptOverride replacement (voice precedent). */
  charter: string;
}

/** Manager handshake (spec §A3 "factory callback" choice): runner-construction
 *  inputs stay inside AgentManager; the pool holds only capabilities. */
export interface WorkerPoolManagerHooks {
  /** Builds AgentRunner + ClaudeAgentAdapter from the cloned worker config —
   *  prefixCache deliberately omitted, workerPool deliberately not passed. */
  buildWorkerAdapter(workerConfig: AgentConfig): AgentProviderAdapter;
  breakerStateFor(provider: "claude"): CircuitBreakerSnapshot | null;
}

export interface WorkerPoolRegistry {
  get(id: string): AgentConfig | undefined;
}

export interface MeetingWorkerPoolDeps {
  db: Db;
  registry: WorkerPoolRegistry;
  config: MeetingWorkersConfig;
  /** Scheduler-seam precedent — index.ts wires `(item) => dispatcher.dispatch(item).catch(…)`. */
  onDispatch: (item: WorkItem) => void;
  /** Test seams. */
  dedup?: typeof classifyClaimDedup;
  now?: () => Date;
}

export function normalizedTaskKey(taskText: string): string {
  return createHash("sha256").update(taskText.toLowerCase().replace(/\s+/g, " ").trim()).digest("hex");
}

function taskPreview(taskText: string): string {
  return taskText.slice(0, TASK_PREVIEW_CHARS);
}

function isDuplicateKeyError(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === 11000;
}

interface LiveWorker {
  abort: () => void;
  bossAgentId: string;
}

export class MeetingWorkerPool {
  private readonly claims: Collection<WorkerClaimDoc>;
  private readonly liveWorkers = new Map<string, LiveWorker>();
  private manager?: WorkerPoolManagerHooks;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  private readonly now: () => Date;
  private readonly dedup: typeof classifyClaimDedup;

  constructor(private readonly deps: MeetingWorkerPoolDeps) {
    this.claims = deps.db.collection<WorkerClaimDoc>("meeting_worker_claims");
    this.now = deps.now ?? (() => new Date());
    this.dedup = deps.dedup ?? classifyClaimDedup;
  }

  /** Called by AgentManager.setWorkerPool (index.ts wiring). */
  bindManager(hooks: WorkerPoolManagerHooks): void {
    this.manager = hooks;
  }

  async ensureIndexes(): Promise<void> {
    // The atomic "I got this" — two bosses inserting the identical normalized
    // task race on this index; the loser's duplicate-key error is the
    // claim-denied signal (spec §A2).
    await this.claims.createIndex(
      { threadId: 1, taskKey: 1 },
      { unique: true, partialFilterExpression: { status: "running" } },
    );
    await this.claims.createIndex({ threadId: 1, status: 1 });
    // Housekeeping only — live expiry is the watchdog's job via expiresAt.
    await this.claims.createIndex({ updatedAt: 1 }, { expireAfterSeconds: CLAIMS_TTL_SECONDS });
  }

  async start(): Promise<void> {
    await this.ensureIndexes();
    await this.sweepOnRestart();
    this.watchdogTimer = setInterval(() => {
      this.sweepExpired().catch((err) => log.error("Worker watchdog sweep failed", { error: String(err) }));
    }, WATCHDOG_INTERVAL_MS);
    this.watchdogTimer.unref?.();
  }

  stop(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    for (const [claimId, worker] of this.liveWorkers) {
      try {
        worker.abort();
      } catch (err) {
        log.warn("Worker abort threw during pool stop — contained", { claimId, error: String(err) });
      }
    }
  }

  /** stopAgent hook — aborts THIS boss's live workers only. Claims stay
   *  `running` and are owned by the cancel/watchdog/restart-sweep paths. */
  abortForBoss(agentId: string): void {
    for (const [claimId, worker] of this.liveWorkers) {
      if (worker.bossAgentId !== agentId) continue;
      try {
        worker.abort();
      } catch (err) {
        log.warn("Worker abort threw in abortForBoss — contained", { claimId, error: String(err) });
      }
    }
  }

  // -------------------------------------------------------------------------
  // Tool surface (called by worker-pool-mcp-server handlers)
  // -------------------------------------------------------------------------

  /** worker_dispatch — handler sequence per spec §A1 (steps 1–6; only step 5 is atomic). */
  async dispatch(req: { bossAgentId: string; task: string; context: WorkerPoolTurnContext }): Promise<string> {
    const cfg = this.deps.config;
    if (!cfg.enabled) {
      return "The meeting worker pool is disabled on this instance (meetingWorkers.enabled: false). Do the work in your own turn, via bg_execute, or an in-turn Task subagent.";
    }
    const ctx = req.context;
    // 1. Meeting gate — mirrors dispatcher step 0.7's discriminator (both halves).
    if (ctx.channelKind !== "slack" || !ctx.channelLabel?.startsWith("conf-") || !ctx.threadId) {
      return "worker_dispatch is meeting-only (Slack conf-* channels). Use bg_execute for shell work or an in-turn Task subagent instead.";
    }
    if (!this.manager) {
      return "The worker pool is not fully wired yet — try again shortly.";
    }
    // 2. Breaker pre-check (read-only — no permit, nothing recorded; KPR-354 posture).
    const breaker = this.manager.breakerStateFor("claude");
    if (breaker && breaker.enabled && breaker.state === "open") {
      return "Provider outage (claude circuit open) — I can't dispatch a worker right now. Tell the room and retry once service recovers.";
    }
    // 3. Caps — check-then-act, bounded overshoot EXPLICITLY accepted (spec §A1
    //    step 3): caps are load valves, not correctness invariants. Do NOT add
    //    locking or post-insert re-count machinery here.
    if (this.liveWorkers.size >= cfg.maxConcurrent) {
      return `Worker pool saturated (${this.liveWorkers.size}/${cfg.maxConcurrent} engine-wide) — retry shortly or do the work in your own turn.`;
    }
    const runningHere = await this.claims.countDocuments({ threadId: ctx.threadId, status: "running" });
    if (runningHere >= cfg.perMeetingMax) {
      return `This meeting already has ${runningHere}/${cfg.perMeetingMax} workers running — wait for one to report back.`;
    }
    // 4. Semantic dedup (best-effort, fail-open — spec §A2).
    const open = await this.claims
      .find({ threadId: ctx.threadId, status: "running" })
      .sort({ createdAt: -1 })
      .limit(10)
      .toArray();
    let dedupStamp: WorkerClaimDoc["dedup"];
    if (open.length > 0) {
      const verdict = await this.dedup(
        req.task,
        open.map((c) => ({ claimId: c._id.toString(), taskText: c.taskText })),
      );
      dedupStamp = {
        compared: open.length,
        verdict: verdict.duplicateOfClaimId ? "duplicate" : "unique",
        costUsd: verdict.costUsd,
      };
      if (verdict.duplicateOfClaimId) {
        const dup = open.find((c) => c._id.toString() === verdict.duplicateOfClaimId);
        if (dup) {
          log.info("Worker claim denied (duplicate)", {
            claimId: dup._id.toString(),
            bossAgentId: req.bossAgentId,
            threadId: ctx.threadId,
            taskPreview: taskPreview(req.task),
          });
          return this.alreadyClaimedText(dup);
        }
      }
    }
    // 5. Atomic claim — the insert is the only atomic step.
    const nowDate = this.now();
    const doc: WorkerClaimDoc = {
      _id: new ObjectId(),
      threadId: ctx.threadId,
      source: {
        adapterId: ctx.adapterId ?? "",
        channelId: ctx.channelId ?? "",
        channelKind: ctx.channelKind ?? "slack",
        channelLabel: ctx.channelLabel ?? "",
        slackTs: ctx.slackTs ?? "",
        slackThreadTs: ctx.slackThreadTs ?? "",
      },
      taskText: req.task,
      taskKey: normalizedTaskKey(req.task),
      status: "running",
      bossAgentId: req.bossAgentId,
      workerModel: cfg.workerModel,
      createdAt: nowDate,
      updatedAt: nowDate,
      expiresAt: new Date(nowDate.getTime() + cfg.claimTtlMinutes * 60_000),
      ...(dedupStamp ? { dedup: dedupStamp } : {}),
    };
    try {
      await this.claims.insertOne(doc);
    } catch (err) {
      if (isDuplicateKeyError(err)) {
        const winner = await this.claims.findOne({ threadId: ctx.threadId, taskKey: doc.taskKey, status: "running" });
        if (winner) return this.alreadyClaimedText(winner);
        // Winner already finished between throw and read — extremely narrow;
        // honest retry text rather than a second insert attempt.
        return "That task was just claimed and completed — check worker_status before re-dispatching.";
      }
      throw err; // MCP handler try/catch shapes this into a structured error
    }
    // 6. Detached spawn — containment lives inside runWorkerTurn (never throws).
    void this.spawnFetchWorker(doc);
    log.info("Worker dispatched", {
      claimId: doc._id.toString(),
      bossAgentId: req.bossAgentId,
      threadId: ctx.threadId,
      taskPreview: taskPreview(req.task),
    });
    return `Worker dispatched (claim ${doc._id.toString()}). You'll be re-triggered here with the report — tell the room you've sent someone and end your turn.`;
  }

  /** worker_status — one line per claim, task preview capped at 80 chars. */
  async status(threadId: string): Promise<string> {
    const docs = await this.claims.find({ threadId }).sort({ createdAt: -1 }).limit(20).toArray();
    if (docs.length === 0) return "No worker claims for this meeting yet.";
    const nowMs = this.now().getTime();
    return docs
      .map((c) => {
        const ageMin = Math.max(0, Math.round((nowMs - c.createdAt.getTime()) / 60_000));
        const name = this.deps.registry.get(c.bossAgentId)?.name ?? c.bossAgentId;
        return `${c._id.toString()} — ${c.status} — ${name} — ${ageMin}m — ${taskPreview(c.taskText)}`;
      })
      .join("\n");
  }

  /** worker_cancel — flip-then-abort; completion after cancel drops on the atomic gate (E13). */
  async cancel(claimId: string, bossAgentId: string): Promise<string> {
    if (!ObjectId.isValid(claimId)) return `Claim not found: ${claimId}`;
    const _id = new ObjectId(claimId);
    const doc = await this.claims.findOne({ _id });
    if (!doc) return `Claim not found: ${claimId}`;
    if (doc.bossAgentId !== bossAgentId) {
      const name = this.deps.registry.get(doc.bossAgentId)?.name ?? doc.bossAgentId;
      return `Not yours — that claim was dispatched by ${name}.`;
    }
    const updated = await this.claims.findOneAndUpdate(
      { _id, status: "running" },
      { $set: { status: "cancelled" as const, error: "cancelled by dispatching boss", updatedAt: this.now() } },
    );
    if (!updated) return `Already finished (status: ${doc.status}).`;
    const live = this.liveWorkers.get(claimId);
    if (live) {
      try {
        live.abort();
      } catch (err) {
        log.warn("Worker abort threw in cancel — contained", { claimId, error: String(err) });
      }
    }
    log.info("Worker claim cancelled", { claimId, bossAgentId });
    return `Cancelled claim ${claimId}.`;
  }

  private alreadyClaimedText(claim: WorkerClaimDoc): string {
    const name = this.deps.registry.get(claim.bossAgentId)?.name ?? claim.bossAgentId;
    const ageMin = Math.max(0, Math.round((this.now().getTime() - claim.createdAt.getTime()) / 60_000));
    return `Already claimed by ${name} (claim ${claim._id.toString()}, started ${ageMin}m ago), in progress — say so in the thread.`;
  }

  // -------------------------------------------------------------------------
  // Worker spawn path (spec §A3)
  // -------------------------------------------------------------------------

  /** Fetch-worker role — Part A's only WorkerRoleParams instantiation. */
  private async spawnFetchWorker(claim: WorkerClaimDoc): Promise<void> {
    const boss = this.deps.registry.get(claim.bossAgentId); // re-checked live
    if (!boss) {
      // Boss vanished between dispatch and spawn — terminal-fail the claim;
      // dispatchReentry's own guard will skip the notice (E6).
      await this.finishClaim(claim, { status: "failed", error: "boss config missing at spawn", durationMs: 0 });
      return;
    }
    const role: WorkerRoleParams = {
      model: this.deps.config.workerModel,
      coreServers: boss.coreServers.filter((s) => !WORKER_SERVER_DENYLIST.has(s)),
      maxTurns: this.deps.config.workerMaxTurns,
      timeoutMs: this.deps.config.workerTimeoutMs,
      charter: fetchWorkerCharter(boss, claim),
    };
    await this.runWorkerTurn(claim, boss, role);
  }

  /**
   * Role-parameterized worker turn (spec §A3 plan directive — KPR-409's
   * scribe reuses this with its own role object). Never throws; completion
   * (both outcomes) transitions the claim atomically and the finally always
   * clears the live-worker handle.
   *
   * NOT budget-accounted, lock-exempt, breaker-invisible, sessionless —
   * all by construction (see spec §A3 rationale).
   */
  private async runWorkerTurn(claim: WorkerClaimDoc, boss: AgentConfig, role: WorkerRoleParams): Promise<void> {
    const claimId = claim._id.toString();
    const startedAt = Date.now();
    try {
      // Server containment is TWO-part: this config clone strips the
      // explicitly-listed denylist servers, and the runner-side
      // suppressAutoInjectedServers flag (set inside buildWorkerAdapter,
      // Task G3) blocks the runner's unconditional auto-injection of
      // team/schedule/team-roster/skill-author/workflow — without the flag,
      // stripping them from coreServers would be a no-op
      // (effectiveCoreServerSet/filterCoreServers re-add them).
      const workerConfig: AgentConfig = {
        ...boss,
        model: role.model,
        coreServers: role.coreServers,
        delegateServers: [], // C19: workers never nest delegates
        schedule: [], // paranoia — nothing reads it on this path, keep it inert
      };
      if (!this.manager) throw new Error("worker pool manager hooks not bound");
      const adapter = this.manager.buildWorkerAdapter(workerConfig);
      this.liveWorkers.set(claimId, { abort: () => adapter.abort(), bossAgentId: claim.bossAgentId });
      const result = await adapter.runTurn({
        prompt: workerTaskPrompt(claim),
        sessionId: undefined, // sessionless — fresh every time, `sessions` untouched
        workItemContext: workItemContextFromClaim(claim),
        resourceLimits: {
          maxTurns: role.maxTurns,
          timeoutMs: role.timeoutMs,
          budgetUsd: boss.budgetUsd, // operator's per-turn cost cap still binds
        },
        systemPromptOverride: role.charter, // total replacement — voice precedent
      });
      const durationMs = Date.now() - startedAt;
      if (result.aborted) {
        // Abort is always initiator-owned (worker_cancel flipped the status
        // first; stopAgent/shutdown leave the claim to the watchdog/restart
        // sweep, which own the honest notice). No transition, no re-entry.
        log.info("Worker aborted — claim left to its owning path", { claimId, durationMs });
        return;
      }
      if (result.timedOut) {
        await this.finishClaim(claim, {
          status: "failed",
          error: `worker timed out after ${role.timeoutMs}ms`,
          durationMs,
          costUsd: result.costUsd,
          toolCalls: result.toolCalls,
        });
        return;
      }
      if (result.error) {
        await this.finishClaim(claim, {
          status: "failed",
          error: result.error.slice(0, 2000),
          durationMs,
          costUsd: result.costUsd,
          toolCalls: result.toolCalls,
        });
        return;
      }
      await this.finishClaim(claim, {
        status: "done",
        resultText: truncateResult(result.text),
        durationMs,
        costUsd: result.costUsd,
        toolCalls: result.toolCalls,
      });
    } catch (err) {
      // finally-disciplined wrapper that never throws (spec §A3 completion).
      await this.finishClaim(claim, {
        status: "failed",
        error: String(err).slice(0, 2000),
        durationMs: Date.now() - startedAt,
      }).catch((e) => log.error("Worker completion write failed", { claimId, error: String(e) }));
    } finally {
      this.liveWorkers.delete(claimId);
    }
  }

  /** Atomic completion transition; drops the result if the claim already
   *  left `running` (expired/cancelled/restart-swept — E13). */
  private async finishClaim(
    claim: WorkerClaimDoc,
    outcome: {
      status: "done" | "failed";
      resultText?: string;
      error?: string;
      durationMs: number;
      costUsd?: number;
      toolCalls?: number;
    },
  ): Promise<void> {
    const claimId = claim._id.toString();
    const updated = await this.claims.findOneAndUpdate(
      { _id: claim._id, status: "running" },
      {
        $set: {
          status: outcome.status,
          ...(outcome.resultText !== undefined ? { resultText: outcome.resultText } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          durationMs: outcome.durationMs,
          ...(outcome.costUsd !== undefined ? { costUsd: outcome.costUsd } : {}),
          ...(outcome.toolCalls !== undefined ? { toolCalls: outcome.toolCalls } : {}),
          updatedAt: this.now(),
        },
      },
    );
    if (!updated) {
      log.info("Worker result dropped (claim no longer running)", { claimId });
      return;
    }
    log.info(outcome.status === "done" ? "Worker completed" : "Worker failed", {
      claimId,
      durationMs: outcome.durationMs,
      costUsd: outcome.costUsd,
      toolCalls: outcome.toolCalls,
    });
    this.dispatchReentry({ ...claim, resultText: outcome.resultText, error: outcome.error }, outcome.status);
  }

  // -------------------------------------------------------------------------
  // Completion → boss re-entry (spec §A4)
  // -------------------------------------------------------------------------

  private dispatchReentry(
    claim: Pick<WorkerClaimDoc, "_id" | "threadId" | "source" | "taskText" | "bossAgentId" | "resultText" | "error">,
    status: "done" | "failed" | "expired",
  ): void {
    const claimId = claim._id.toString();
    // Boss-gone guard — LOAD-BEARING (E6): without it, a step-0 miss on a
    // conf-*-labeled item would fall through to resolveConferenceAgents and
    // fire a full classifier fan-out off a system item.
    const boss = this.deps.registry.get(claim.bossAgentId);
    if (!boss || boss.disabled) {
      log.warn("Worker re-entry skipped — boss agent gone or disabled", { claimId, bossAgentId: claim.bossAgentId });
      void this.claims
        .updateOne(
          { _id: claim._id },
          { $set: { error: "re-entry skipped: boss agent gone or disabled", updatedAt: this.now() } },
        )
        .catch((err) => log.error("Claim annotate failed", { claimId, error: String(err) }));
      return;
    }
    const item: WorkItem = {
      id: `worker:${claimId}`, // unique per claim — dispatcher dedup-safe; fires at most once (atomic transition gates)
      text: workerReportPrompt(claim, status),
      source: {
        kind: (claim.source.channelKind || "slack") as ChannelKind,
        id: claim.source.channelId,
        label: claim.source.channelLabel,
        adapterId: claim.source.adapterId,
      },
      sender: "system",
      threadId: claim.threadId,
      timestamp: this.now(),
      meta: {
        slackTs: claim.source.slackTs,
        slackThreadTs: claim.source.slackThreadTs,
        targetAgentId: claim.bossAgentId,
      },
    };
    try {
      this.deps.onDispatch(item);
    } catch (err) {
      log.error("Worker re-entry dispatch threw", { claimId, error: String(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Watchdog + restart sweep (spec §A2)
  // -------------------------------------------------------------------------

  /** 60s interval: flip past-deadline running claims to expired (atomic),
   *  abort any live handle, honest re-entry notice. */
  private async sweepExpired(): Promise<void> {
    const nowDate = this.now();
    const stale = await this.claims.find({ status: "running", expiresAt: { $lt: nowDate } }).toArray();
    for (const claim of stale) {
      await this.expireClaim(claim, "claim TTL expired");
    }
  }

  /** Boot sweep: a fresh process can never have live workers, so every
   *  running claim is an orphan — flip unconditionally with notice (E5). */
  private async sweepOnRestart(): Promise<void> {
    const orphans = await this.claims.find({ status: "running" }).toArray();
    for (const claim of orphans) {
      await this.expireClaim(claim, "engine restarted mid-worker");
    }
  }

  private async expireClaim(claim: WorkerClaimDoc, reason: string): Promise<void> {
    const claimId = claim._id.toString();
    const updated = await this.claims.findOneAndUpdate(
      { _id: claim._id, status: "running" },
      { $set: { status: "expired" as const, error: reason, updatedAt: this.now() } },
    );
    if (!updated) return; // completion or cancel won the race — theirs now
    const live = this.liveWorkers.get(claimId);
    if (live) {
      try {
        live.abort();
      } catch (err) {
        log.warn("Worker abort threw in expiry — contained", { claimId, error: String(err) });
      }
      this.liveWorkers.delete(claimId);
    }
    log.info("Worker claim expired", { claimId, reason, bossAgentId: claim.bossAgentId });
    this.dispatchReentry({ ...claim, error: reason }, "expired");
  }
}

// ---------------------------------------------------------------------------
// Prompt builders (exported for byte pins in tests)
// ---------------------------------------------------------------------------

/** Charter — lean, TOTAL systemPromptOverride replacement: no soul, no
 *  constitution (cheap + focused). The no-posting rule is information here;
 *  the ENFORCEMENT is the denylist (code-enforce-don't-prose-enforce). */
export function fetchWorkerCharter(boss: AgentConfig, claim: WorkerClaimDoc): string {
  return [
    `You are a background research worker acting for ${boss.name} during a meeting in #${claim.source.channelLabel}.`,
    ``,
    `Task:`,
    claim.taskText,
    ``,
    `Return contract: reply with a concise, factual, self-contained report — it will be relayed to the meeting by ${boss.name}. Include concrete numbers, quotes, and file paths where relevant. Say clearly if you could not complete the task.`,
    ``,
    `You have no messaging tools; your final message IS the deliverable.`,
  ].join("\n");
}

export function workerTaskPrompt(claim: WorkerClaimDoc): string {
  return `${claim.taskText}\n\nReply with your report now — concise, factual, self-contained.`;
}

/** Re-entry report prompt. Escape phrase matches NON_RESPONSE_PATTERNS[0]
 *  exactly (C4-coherent — a stale finding suppresses on the existing
 *  single-dispatch isNonResponse branch). */
export function workerReportPrompt(
  claim: Pick<WorkerClaimDoc, "taskText" | "resultText" | "error">,
  status: "done" | "failed" | "expired",
): string {
  const body =
    status === "done"
      ? (claim.resultText ?? "(empty report)")
      : status === "failed"
        ? `The worker failed: ${claim.error ?? "unknown error"}`
        : "The worker did not finish in time — re-dispatch if the room still needs it.";
  return `[Worker report — ${status}] Task: ${claim.taskText}\n\n${body}\n\nYou dispatched this worker during the meeting in this thread. Interpret the finding and post what the room needs, as yourself — do not paste the raw report verbatim if a summary serves better. If the meeting has moved on and this is no longer useful, reply "No response needed."`;
}

export function workItemContextFromClaim(claim: WorkerClaimDoc): {
  adapterId: string;
  channelId: string;
  channelKind: string;
  channelLabel: string;
  threadId: string;
  slackTs: string;
  slackThreadTs: string;
} {
  return {
    adapterId: claim.source.adapterId,
    channelId: claim.source.channelId,
    channelKind: claim.source.channelKind,
    channelLabel: claim.source.channelLabel,
    threadId: claim.threadId,
    slackTs: claim.source.slackTs,
    slackThreadTs: claim.source.slackThreadTs,
  };
}

function truncateResult(text: string): string {
  return text.length <= RESULT_TEXT_CAP
    ? text
    : `${text.slice(0, RESULT_TEXT_CAP)}\n…[truncated at ${RESULT_TEXT_CAP} chars]`;
}
