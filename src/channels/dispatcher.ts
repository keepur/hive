import { createLogger } from "../logging/logger.js";
import type { WorkItem, WorkResult } from "../types/work-item.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { HealthReporter } from "../health/health-reporter.js";
import type { TaskLedger } from "../tasks/task-ledger.js";
import { triage } from "../agents/triage.js";
import { config } from "../config.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import type { RetryQueue } from "../sweeper/retry-queue.js";

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
  private auditChannelId?: string;
  private taskLedger?: TaskLedger;
  private retryQueue?: RetryQueue;
  private teamStore?: import("../team/team-store.js").TeamStore;

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

  setTeamStore(store: import("../team/team-store.js").TeamStore): void {
    this.teamStore = store;
  }

  setAuditChannel(adapter: ChannelAdapter, channelId: string): void {
    this.auditAdapter = adapter;
    this.auditChannelId = channelId;
  }

  async dispatch(item: WorkItem): Promise<void> {
    // 0. Deduplicate — if two adapters see the same Slack message, only process it once
    if (this.recentMessageIds.has(item.id)) {
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

    // Fan-out: if multiple agents resolved, dispatch to each concurrently
    if (activeList.length > 1) {
      const threadId = item.threadId ?? item.id;
      // Persist participant set so follow-up messages fan out to all participants
      if (!this.threadParticipants.has(threadId)) {
        this.threadParticipants.set(threadId, new Set(activeList.map((r) => r.agentId)));
      }
      this.threadAgentLastSeen.set(threadId, Date.now());
      log.info("Multi-agent fan-out", { agents: activeList.map((r) => r.agentId) });
      await Promise.all(activeList.map((r) => this.dispatchToAgent(item, r)));
      return;
    }

    const { agentId, skipTriage } = activeList[0];

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
    const agentConfig = this.registry.get(agentId);

    // 4. Triage gate — fast Haiku response for interactive channels (skip for system/scheduled)
    const isInteractive =
      (item.source.kind === "slack" ||
        item.source.kind === "sms" ||
        item.source.kind === "imessage" ||
        item.source.kind === "team") &&
      item.sender !== "system";
    let processingStarted = false;
    if (isInteractive && config.triage.enabled && agentConfig && !skipTriage) {
      await adapter?.onProcessingStart?.(item);
      processingStarted = true;
      try {
        const triageResult = await triage(item.text, agentConfig, {
          isThread: !!item.meta?.slackThreadTs,
        });

        if (triageResult.action === "done") {
          const workResult: WorkResult = {
            text: triageResult.response,
            agentId,
            workItem: item,
            costUsd: triageResult.costUsd,
            durationMs: triageResult.durationMs,
          };
          if (adapter) {
            try {
              await adapter.deliver(workResult);
            } catch (err) {
              log.warn("Triage delivery failed, queuing for retry", { error: String(err) });
              this.retryQueue?.enqueue(workResult, adapter);
            }
          }
          if (this.auditAdapter && item.source.kind !== this.auditAdapter.kind) {
            await this.postAuditLog(workResult);
          }
          log.info("Triage handled message", {
            agentId,
            source: item.source.kind,
            costUsd: triageResult.costUsd,
            durationMs: triageResult.durationMs,
          });
          await adapter?.onProcessingEnd?.(item);
          return;
        }

        // action === "continue" — post ack immediately, then proceed to full agent
        // Skip ack in threads — "Thinking..." indicator is already visible and the ack
        // creates a redundant 2-turn feel (ack + real response)
        const isThread = !!item.meta?.slackThreadTs;
        if (adapter && !isThread) {
          const ackResult: WorkResult = {
            text: triageResult.response,
            agentId,
            workItem: item,
            costUsd: triageResult.costUsd,
            durationMs: triageResult.durationMs,
          };
          try {
            await adapter.deliver(ackResult);
          } catch (err) {
            log.warn("Triage ack delivery failed, queuing for retry", { error: String(err) });
            this.retryQueue?.enqueue(ackResult, adapter);
          }
        }
        log.info("Triage ack posted, continuing to full agent", {
          agentId,
          source: item.source.kind,
          ack: triageResult.response.slice(0, 80),
        });
      } catch (err) {
        log.warn("Triage failed, falling through to full agent", { error: String(err) });
      }
    }

    // 5. Full agent processing
    if (!processingStarted) await adapter?.onProcessingStart?.(item);
    try {
      const runResult = await this.agentManager.sendMessage(agentId, item);

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

        if (adapter) {
          try {
            await adapter.deliver(workResult);
          } catch (err) {
            log.warn("Agent response delivery failed, queuing for retry", { error: String(err) });
            this.retryQueue?.enqueue(workResult, adapter);
          }
        }

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
    } catch (err) {
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
    } finally {
      await adapter?.onProcessingEnd?.(item);
    }
  }

  /** Evict stale dedup entries to prevent memory growth */
  private pruneDedup(): void {
    const cutoff = Date.now() - Dispatcher.DEDUP_TTL_MS;
    for (const [id, ts] of this.recentMessageIds) {
      if (ts < cutoff) this.recentMessageIds.delete(id);
    }
  }

  private async resolveAgents(item: WorkItem): Promise<{ agentId: string; skipTriage: boolean }[]> {
    // 0. Explicit target — callbacks and internal routing specify exact agent
    //    Always returns single agent, even in multi-agent threads
    const targetAgentId = item.meta?.targetAgentId as string | undefined;
    if (targetAgentId && this.registry.get(targetAgentId)) {
      return [{ agentId: targetAgentId, skipTriage: false }];
    }

    // 0.5 Team routing — DMs resolve to channel member, channels use @mention or triage
    if (item.source.kind === "team") {
      return this.resolveFromTeam(item);
    }

    // 1. Dedicated channel mapping — always route to channel owner
    //    Prevents name collisions (e.g. customer "Jasper" routing to agent Jasper in #agent-jessica)
    //    Checked before thread logic so dedicated channels never become multi-agent
    const channelAgent = this.registry.findByChannel(item.source.label);
    if (channelAgent) return [{ agentId: channelAgent.id, skipTriage: false }];

    // 2. Thread participant resolution — scan for new mentions in existing threads
    if (item.threadId) {
      const newMentions = this.registry.findAllByName(item.text);
      const newMentionIds = new Set(newMentions.map((a) => a.id));

      // 2a. Existing multi-agent thread — add any new mentions
      const existingParticipants = this.threadParticipants.get(item.threadId);
      if (existingParticipants) {
        for (const id of newMentionIds) existingParticipants.add(id);
        this.threadAgentLastSeen.set(item.threadId, Date.now());
        return [...existingParticipants].map((agentId) => ({ agentId, skipTriage: false }));
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
          return [...participants].map((agentId) => ({ agentId, skipTriage: false }));
        }
        // Single-agent continuity (unchanged behavior)
        this.threadAgentLastSeen.set(item.threadId, Date.now());
        return [{ agentId: existing, skipTriage: false }];
      }

      // 2c. No in-memory affinity — check persisted sessions (survives restart)
      const persisted = await this.agentManager.findAgentsForThread(item.threadId);
      if (persisted.length > 0) {
        const validAgents = persisted.filter((id) => this.registry.get(id));
        if (validAgents.length > 1) {
          const participants = new Set(validAgents);
          this.threadParticipants.set(item.threadId, participants);
          this.threadAgentLastSeen.set(item.threadId, Date.now());
          return [...participants].map((agentId) => ({ agentId, skipTriage: false }));
        }
        if (validAgents.length === 1) {
          this.threadAgentMap.set(item.threadId, validAgents[0]);
          this.threadAgentLastSeen.set(item.threadId, Date.now());
          return [{ agentId: validAgents[0], skipTriage: false }];
        }
      }
    }

    // 3. Name addressing — works in shared channels ("hey Jasper", "@Jasper", "Jasper, ...")
    //    May return multiple agents if several are mentioned in the same message
    const allNamed = this.registry.findAllByName(item.text);
    if (allNamed.length > 0) {
      return allNamed.map((a) => ({
        agentId: a.id,
        skipTriage: a.passiveChannels.includes(item.source.label),
      }));
    }

    // 4. Adapter-specific default (e.g. DMs to Jasper's bot → vp-engineering)
    const adapterDefault = item.meta?.defaultAgentId as string | undefined;
    if (adapterDefault && this.registry.get(adapterDefault)) return [{ agentId: adapterDefault, skipTriage: false }];

    // 5. Keyword match — disabled (too many false positives in shared channels)
    // const keyword = this.registry.findByKeyword(item.text);
    // if (keyword) return [{ agentId: keyword.id, skipTriage: false }];

    // 6. No match — drop unless it's a dedicated channel or DM
    //    Agents must be explicitly addressed (name mention, dedicated channel, thread continuity, or DM)
    log.debug("No agent matched — dropping", { channel: item.source.label });
    return [];
  }

  private async resolveFromTeam(item: WorkItem): Promise<{ agentId: string; skipTriage: boolean }[]> {
    const channelId = item.meta?.channelId as string | undefined;
    if (!channelId || !this.teamStore) {
      // Fall back to default agent
      const defaultId = item.meta?.defaultAgentId as string | undefined;
      if (defaultId && this.registry.get(defaultId)) return [{ agentId: defaultId, skipTriage: false }];
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
        return [{ agentId, skipTriage: true }]; // DMs skip triage — direct
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
        return validMentions.map((a) => ({ agentId: a.id, skipTriage: true }));
      }
    }

    // No mention — route to first agent member of the channel (lightweight default)
    // In future, could use triage to pick best responder
    const agentMembers = channel.members.filter((m) => this.registry.get(m));
    if (agentMembers.length > 0) {
      return [{ agentId: agentMembers[0], skipTriage: false }];
    }

    log.warn("No agent members in Team channel", { channelId });
    return [];
  }

  /** Dispatch a single work item to a single agent (used for fan-out) */
  private async dispatchToAgent(item: WorkItem, resolved: { agentId: string; skipTriage: boolean }): Promise<void> {
    const { agentId, skipTriage } = resolved;

    const threadId = item.threadId ?? item.id;
    // Refresh TTL for multi-agent threads (affinity already set by resolveAgents)
    this.threadAgentLastSeen.set(threadId, Date.now());

    const tracked = this.taskLedger?.shouldTrack(item) ?? false;
    if (tracked) {
      this.taskLedger!.onDispatch(item, agentId).catch((err) =>
        log.warn("Task ledger dispatch failed", { error: String(err) }),
      );
    }

    const adapter = this.adapters.get(item.source.adapterId ?? item.source.kind);
    const agentConfig = this.registry.get(agentId);

    const isInteractive =
      (item.source.kind === "slack" ||
        item.source.kind === "sms" ||
        item.source.kind === "imessage" ||
        item.source.kind === "team") &&
      item.sender !== "system";

    // Skip triage for fan-out — go straight to full agent
    if (isInteractive && config.triage.enabled && agentConfig && !skipTriage) {
      try {
        const triageResult = await triage(item.text, agentConfig, {
          isThread: !!item.meta?.slackThreadTs,
        });
        if (triageResult.action === "done") {
          const workResult: WorkResult = {
            text: triageResult.response,
            agentId,
            workItem: item,
            costUsd: triageResult.costUsd,
            durationMs: triageResult.durationMs,
          };
          if (adapter) {
            try {
              await adapter.deliver(workResult);
            } catch (err) {
              this.retryQueue?.enqueue(workResult, adapter);
            }
          }
          if (this.auditAdapter && item.source.kind !== this.auditAdapter.kind) {
            await this.postAuditLog(workResult);
          }
          return;
        }
        // "continue" — no ack for fan-out, proceed to full agent
      } catch (err) {
        log.warn("Triage failed in fan-out, falling through to full agent", { agentId, error: String(err) });
      }
    }

    try {
      const runResult = await this.agentManager.sendMessage(agentId, item);
      const trimmedText = runResult.text.trim();
      const isNonResponse = NON_RESPONSE_PATTERNS.some((p) => p.test(trimmedText));

      if (isNonResponse) {
        log.info("Non-response suppressed (fan-out)", { agentId });
      } else {
        const workResult: WorkResult = {
          text: runResult.text || "_No response._",
          agentId,
          workItem: item,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
          error: runResult.error,
        };
        if (adapter) {
          try {
            await adapter.deliver(workResult);
          } catch (err) {
            this.retryQueue?.enqueue(workResult, adapter);
          }
        }
        if (tracked) {
          this.taskLedger!.onComplete(workResult).catch((err) =>
            log.warn("Task ledger complete failed", { error: String(err) }),
          );
        }
        if (this.auditAdapter && item.source.kind !== this.auditAdapter.kind) {
          await this.postAuditLog(workResult);
        }
        log.info("Fan-out dispatch complete", {
          agentId,
          costUsd: runResult.costUsd,
          durationMs: runResult.durationMs,
        });
      }
    } catch (err) {
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
          this.retryQueue?.enqueue(errorResult, adapter);
        }
      }
      log.error("Fan-out dispatch failed", { agentId, error: String(err) });
    }
  }

  sweep(threadTtlMs: number): SweepResult {
    const cutoff = Date.now() - threadTtlMs;
    let pruned = 0;
    for (const [id, ts] of this.threadAgentLastSeen) {
      if (ts < cutoff) {
        this.threadAgentMap.delete(id);
        this.threadParticipants.delete(id);
        this.threadAgentLastSeen.delete(id);
        pruned++;
      }
    }
    return { component: "dispatcher", pruned, retried: 0, bytesFreed: 0, errors: [] };
  }

  private async postAuditLog(result: WorkResult): Promise<void> {
    if (!this.auditAdapter || !this.auditChannelId) return;

    const agentConfig = this.registry.get(result.agentId);
    const agentName = agentConfig?.name ?? result.agentId;
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
      source: { kind: "internal", id: this.auditChannelId, label: "audit" },
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
