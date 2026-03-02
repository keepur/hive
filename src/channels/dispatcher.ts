import { createLogger } from "../logging/logger.js";
import type { WorkItem, WorkResult } from "../types/work-item.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { HealthReporter } from "../health/health-reporter.js";

const log = createLogger("dispatcher");

const STATUS_PATTERNS = [
  /^status\??$/i,
  /how.*(everyone|agents?|doing|running)/i,
  /^health\??$/i,
  /system status/i,
];

export class Dispatcher {
  private adapters = new Map<string, ChannelAdapter>();
  private registry: AgentRegistry;
  private agentManager: AgentManager;
  private healthReporter: HealthReporter;
  private defaultAgentId: string;
  private threadAgentMap = new Map<string, string>(); // threadId -> agentId
  private recentMessageIds = new Map<string, number>(); // messageTs -> timestamp (dedup)
  private auditAdapter?: ChannelAdapter;
  private auditChannelId?: string;

  private static readonly DEDUP_TTL_MS = 60_000; // 1 minute TTL for dedup entries

  constructor(
    registry: AgentRegistry,
    agentManager: AgentManager,
    healthReporter: HealthReporter,
    defaultAgentId: string,
  ) {
    this.registry = registry;
    this.agentManager = agentManager;
    this.healthReporter = healthReporter;
    this.defaultAgentId = defaultAgentId;
  }

  registerAdapter(adapter: ChannelAdapter): void {
    this.adapters.set(adapter.id, adapter);
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

    // 1. Intercept status queries
    if (STATUS_PATTERNS.some((p) => p.test(item.text.trim()))) {
      const statusText = this.healthReporter.formatForSlack();
      const adapter = this.adapters.get(item.source.adapterId ?? item.source.kind);
      if (adapter) {
        await adapter.deliver({
          text: statusText,
          agentId: "system",
          workItem: item,
          costUsd: 0,
          durationMs: 0,
        });
      }
      return;
    }

    // 2. Resolve agent
    const agentId = this.resolveAgent(item);
    if (!agentId) {
      log.warn("No agent found for work item", {
        source: item.source.kind,
        label: item.source.label,
        text: item.text.slice(0, 50),
      });
      return;
    }

    const threadId = item.threadId ?? item.id;
    this.threadAgentMap.set(threadId, agentId);

    // 3. Notify adapter processing started
    const adapter = this.adapters.get(item.source.adapterId ?? item.source.kind);
    await adapter?.onProcessingStart?.(item);

    try {
      // 4. Send to agent
      const runResult = await this.agentManager.sendMessage(agentId, item);

      const workResult: WorkResult = {
        text: runResult.text || "_No response._",
        agentId,
        workItem: item,
        costUsd: runResult.costUsd,
        durationMs: runResult.durationMs,
        error: runResult.error,
      };

      // 5. Deliver response
      if (adapter) {
        await adapter.deliver(workResult);
      }

      // 6. Audit log for cross-channel activity
      if (this.auditAdapter && item.source.kind !== this.auditAdapter.kind) {
        await this.postAuditLog(workResult);
      }

      log.info("Work item dispatched", {
        agentId,
        source: item.source.kind,
        costUsd: runResult.costUsd,
        durationMs: runResult.durationMs,
      });
    } catch (err) {
      const errorResult: WorkResult = {
        text: `Something went wrong: ${String(err)}`,
        agentId,
        workItem: item,
        costUsd: 0,
        durationMs: 0,
        error: String(err),
      };
      if (adapter) await adapter.deliver(errorResult);
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

  private resolveAgent(item: WorkItem): string | null {
    // 1. Thread continuity
    if (item.threadId) {
      const existing = this.threadAgentMap.get(item.threadId);
      if (existing) return existing;
    }

    // 2. Name addressing ("hey River", "@River", "River, ...")
    const named = this.registry.findByName(item.text);
    if (named) return named.id;

    // 3. Channel mapping (source.label matches agent channels[])
    const channelAgent = this.registry.findByChannel(item.source.label);
    if (channelAgent) return channelAgent.id;

    // 4. Keyword match
    const keyword = this.registry.findByKeyword(item.text);
    if (keyword) return keyword.id;

    // 5. Adapter-specific default (e.g. DMs to Jasper's bot → vp-engineering)
    const adapterDefault = item.meta?.defaultAgentId as string | undefined;
    if (adapterDefault && this.registry.get(adapterDefault)) return adapterDefault;

    // 6. Global default
    return this.defaultAgentId;
  }

  private async postAuditLog(result: WorkResult): Promise<void> {
    if (!this.auditAdapter || !this.auditChannelId) return;

    const agentConfig = this.registry.get(result.agentId);
    const agentName = agentConfig?.name ?? result.agentId;
    const icon =
      result.workItem.source.kind === "sms"
        ? ":phone:"
        : ":incoming_envelope:";
    const senderDisplay = result.workItem.senderName ?? result.workItem.sender;
    const summary =
      result.text.length > 300
        ? result.text.slice(0, 300) + "..."
        : result.text;

    const auditItem: WorkItem = {
      id: `audit:${result.workItem.id}`,
      text: `${icon} *${agentName}* handled ${result.workItem.source.kind} from ${senderDisplay}:\n> ${summary}\n_($${result.costUsd.toFixed(3)} \u00b7 ${(result.durationMs / 1000).toFixed(1)}s)_`,
      source: { kind: "internal", id: this.auditChannelId, label: "audit" },
      sender: "system",
      timestamp: new Date(),
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
