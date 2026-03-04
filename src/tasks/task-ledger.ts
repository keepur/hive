import { createLogger } from "../logging/logger.js";
import type { WorkItem, WorkResult } from "../types/work-item.js";
import type { SweepResult } from "../sweeper/sweeper.js";

const log = createLogger("task-ledger");

/**
 * Auto-tracks invisible agent work (scheduled jobs, background tasks, meetings, email)
 * as tasks in the dodi_v2 task ledger. Fire-and-forget — never blocks the message pipeline.
 */
export class TaskLedger {
  private threadTaskMap = new Map<string, string>(); // threadId → taskId
  private threadTaskLastSeen = new Map<string, number>();
  private apiUrl: string;
  private agentKeys: Record<string, string>;
  private fallbackKey: string;

  constructor(apiUrl: string, agentKeys: Record<string, string>, fallbackKey: string) {
    this.apiUrl = apiUrl;
    this.agentKeys = agentKeys;
    this.fallbackKey = fallbackKey;
  }

  get isConfigured(): boolean {
    return Object.keys(this.agentKeys).length > 0 || this.fallbackKey.length > 0;
  }

  /** Only track work that doesn't already surface in Slack/SMS */
  shouldTrack(item: WorkItem): boolean {
    return item.source.kind !== "slack" && item.source.kind !== "sms";
  }

  /** Called after agent resolution, before processing. Creates task or adds comment. */
  async onDispatch(item: WorkItem, agentId: string): Promise<void> {
    const apiKey = this.getApiKey(agentId);
    if (!apiKey) return;

    const threadId = item.threadId ?? item.id;

    // Thread continuation → add comment to existing task
    const existingTaskId = this.threadTaskMap.get(threadId);
    if (existingTaskId) {
      this.threadTaskLastSeen.set(threadId, Date.now());
      await this.addComment(existingTaskId, apiKey, this.formatIncomingComment(item));
      return;
    }

    // New thread → create task
    const taskId = await this.createTask(apiKey, item);
    if (taskId) {
      this.threadTaskMap.set(threadId, taskId);
      this.threadTaskLastSeen.set(threadId, Date.now());
    }
  }

  /** Called after agent finishes. Updates task to DONE with metrics. */
  async onComplete(result: WorkResult): Promise<void> {
    const apiKey = this.getApiKey(result.agentId);
    if (!apiKey) return;

    const threadId = result.workItem.threadId ?? result.workItem.id;
    const taskId = this.threadTaskMap.get(threadId);
    if (taskId) this.threadTaskLastSeen.set(threadId, Date.now());
    if (!taskId) return;

    // Add agent response as comment
    const comment = this.formatCompletionComment(result);
    await this.addComment(taskId, apiKey, comment);

    // Mark task done (unless it errored)
    if (!result.error) {
      await this.updateTask(taskId, apiKey, { state: "DONE" });
    }
  }

  sweep(threadTtlMs: number): SweepResult {
    const cutoff = Date.now() - threadTtlMs;
    let pruned = 0;
    for (const [id, ts] of this.threadTaskLastSeen) {
      if (ts < cutoff) {
        this.threadTaskMap.delete(id);
        this.threadTaskLastSeen.delete(id);
        pruned++;
      }
    }
    return { component: "task-ledger", pruned, retried: 0, bytesFreed: 0, errors: [] };
  }

  private getApiKey(agentId: string): string | null {
    const key = this.agentKeys[agentId] ?? this.fallbackKey;
    if (!key) {
      log.debug("No task ledger API key for agent", { agentId });
      return null;
    }
    return key;
  }

  private async createTask(apiKey: string, item: WorkItem): Promise<string | null> {
    try {
      const result = await this.api("POST", "/tasks", apiKey, {
        name: this.taskName(item),
        type: this.taskType(item),
        description: this.taskDescription(item),
      });
      log.info("Task created", { taskId: result.taskId, source: item.source.kind });
      return result.taskId;
    } catch (err) {
      log.error("Failed to create task", { error: String(err), source: item.source.kind });
      return null;
    }
  }

  private async addComment(taskId: string, apiKey: string, content: string): Promise<void> {
    try {
      await this.api("POST", `/tasks/${taskId}/comments`, apiKey, { content });
    } catch (err) {
      log.error("Failed to add comment", { error: String(err), taskId });
    }
  }

  private async updateTask(taskId: string, apiKey: string, updates: Record<string, unknown>): Promise<void> {
    try {
      await this.api("PUT", `/tasks/${taskId}`, apiKey, updates);
    } catch (err) {
      log.error("Failed to update task", { error: String(err), taskId });
    }
  }

  private async api(method: string, path: string, apiKey: string, body?: object): Promise<any> {
    const res = await fetch(`${this.apiUrl}/api/v1${path}`, {
      method,
      headers: {
        "x-api-key": apiKey,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) throw new Error(`Task API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  // --- Naming & formatting ---

  private taskName(item: WorkItem): string {
    const text = item.text;

    // Scheduled task: extract task name from "[Scheduled task: foo]" pattern
    const schedMatch = text.match(/\[Scheduled task: (.+?)\]/);
    if (schedMatch) return `[Scheduled] ${schedMatch[1]}`;

    // Background task: extract command
    const bgMatch = text.match(/Command: `(.+?)`/);
    if (bgMatch) return `[Background] ${bgMatch[1].slice(0, 80)}`;

    // Meeting: extract bot name
    const meetingMatch = text.match(/\[Meeting (?:transcript update|ended) — (.+?)\]/);
    if (meetingMatch) return `[Meeting] ${meetingMatch[1]}`;

    // Email
    if (item.source.kind === "email") {
      return `[Email] ${text.slice(0, 80)}`;
    }

    // Fallback
    return `[${item.source.kind}] ${text.slice(0, 80)}`;
  }

  private taskType(item: WorkItem): string {
    if (item.source.kind === "email") return "FOLLOW_UP";

    // Meeting transcript updates that end with a summary → ACTION_ITEM
    if (item.text.includes("[Meeting ended")) return "ACTION_ITEM";

    return "AGENT";
  }

  private taskDescription(item: WorkItem): string {
    const parts = [
      `**Source:** ${item.source.kind} / ${item.source.label}`,
      `**Sender:** ${item.senderName ?? item.sender}`,
      `**Time:** ${item.timestamp.toISOString()}`,
    ];

    if (item.threadId) {
      parts.push(`**Thread:** ${item.threadId}`);
    }

    // Include the full message text (truncated for very long messages like transcripts)
    const maxLen = 5000;
    const body = item.text.length > maxLen
      ? item.text.slice(0, maxLen) + "\n\n... (truncated)"
      : item.text;
    parts.push("", "---", "", body);

    return parts.join("\n");
  }

  private formatIncomingComment(item: WorkItem): string {
    return `**Follow-up message** (${item.source.kind})\n\n${item.text.slice(0, 5000)}`;
  }

  private formatCompletionComment(result: WorkResult): string {
    const parts = [
      `**Agent response** ($${result.costUsd.toFixed(3)} · ${(result.durationMs / 1000).toFixed(1)}s)`,
    ];

    if (result.error) {
      parts.push(`\n**Error:** ${result.error}`);
    }

    const maxLen = 5000;
    const text = result.text.length > maxLen
      ? result.text.slice(0, maxLen) + "\n\n... (truncated)"
      : result.text;
    parts.push("", text);

    return parts.join("\n");
  }
}
