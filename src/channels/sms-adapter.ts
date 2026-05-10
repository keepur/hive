import { createLogger } from "../logging/logger.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { WorkItem, WorkResult, ChannelKind } from "../types/work-item.js";
import type { AgentManager, TurnContext } from "../agents/agent-manager.js";

const log = createLogger("sms-adapter");

const QUO_BASE = "https://api.openphone.com/v1";

interface SmsLine {
  id: string; // phoneNumberId
  label: string; // e.g. "May (CEO)"
  number: string; // E.164 phone number
  routeLabel: string; // channel name for agent routing (e.g. "quo-may")
  lastSeen: string; // ISO 8601 timestamp of last polled message
}

interface QuoMessage {
  id: string;
  from: string;
  to: string[];
  text: string;
  direction: "incoming" | "outgoing";
  createdAt: string;
  userId?: string;
  status?: string;
}

/**
 * KPR-216: optional per-turn-spawn wiring. When `agentManager` and
 * `defaultAgentId` are passed AND `perTurnSpawnEnabled` is true, polled
 * SMS messages skip the dispatcher and go straight through
 * `agentManager.spawnTurn(...)`. Otherwise the adapter falls back to the
 * legacy `onWorkItem` → dispatcher path.
 */
export interface SmsAdapterPerTurnDeps {
  agentManager: AgentManager;
  defaultAgentId: string;
  perTurnSpawnEnabled: boolean;
}

export class SmsAdapter implements ChannelAdapter {
  readonly id: string = "sms";
  readonly kind: ChannelKind = "sms";

  private apiKey: string;
  private lines: SmsLine[];
  private interval: ReturnType<typeof setInterval> | null = null;
  private perTurn?: SmsAdapterPerTurnDeps;

  constructor(
    apiKey: string,
    lines: Array<{ id: string; label: string; number: string; slackChannel?: string }>,
    perTurn?: SmsAdapterPerTurnDeps,
  ) {
    this.apiKey = apiKey;
    this.lines = lines.map((l) => ({
      id: l.id,
      label: l.label,
      number: l.number,
      routeLabel: l.slackChannel ?? l.label,
      lastSeen: new Date().toISOString(),
    }));
    this.perTurn = perTurn;
  }

  async start(onWorkItem: (item: WorkItem) => void): Promise<void> {
    if (this.lines.length === 0) {
      log.warn("SMS adapter has no lines to watch");
      return;
    }

    // Poll immediately, then every 30 seconds
    this.poll(onWorkItem);
    this.interval = setInterval(() => this.poll(onWorkItem), 30_000);
    log.info("SMS adapter started", {
      lines: this.lines.map((l) => l.label),
      perTurnSpawn: this.perTurn?.perTurnSpawnEnabled ?? false,
    });
  }

  async deliver(result: WorkResult): Promise<void> {
    if (result.error) {
      log.warn("Skipping SMS delivery due to error", { error: result.error });
      return;
    }

    const senderPhone = result.workItem.sender;
    const phoneNumberId = result.workItem.source.id;

    try {
      const res = await fetch(`${QUO_BASE}/messages`, {
        method: "POST",
        headers: {
          Authorization: this.apiKey,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from: phoneNumberId,
          to: [senderPhone],
          content: result.text,
        }),
      });

      if (!res.ok) {
        log.error("Failed to send SMS reply", {
          status: res.status,
          body: await res.text(),
          to: senderPhone,
        });
      } else {
        log.info("SMS reply sent", { to: senderPhone, from: phoneNumberId });
      }
    } catch (err) {
      log.error("SMS delivery error", { error: String(err), to: senderPhone });
    }
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    log.info("SMS adapter stopped");
  }

  // --- Private helpers ---

  /**
   * KPR-216: per-turn-spawn path. Resolves the agent (thread continuity →
   * default), pulls the existing session id, spawns a single-turn query,
   * and delivers the result via Quo. Bypasses dispatcher dedup/audit/retry
   * by design — Phase A scope; KPR-220 will fold dispatcher concerns back
   * in once all channels are per-turn.
   */
  private async spawnTurnForWorkItem(workItem: WorkItem): Promise<void> {
    if (!this.perTurn) return;
    const { agentManager, defaultAgentId } = this.perTurn;
    const threadId = workItem.threadId ?? workItem.id;

    const continuedAgentId = await agentManager.findAgentForThread(threadId);
    const agentId = continuedAgentId ?? defaultAgentId;

    const sessionId = await agentManager.getSessionStore().get(agentId, threadId);

    const ctx: TurnContext = {
      agentId,
      sessionId,
      channelId: workItem.source.id,
      threadId,
      workItem,
      channel: workItem.source.kind,
    };

    const turn = await agentManager.spawnTurn(ctx);

    if (turn.errors.length > 0) {
      log.warn("SMS per-turn spawn returned errors", {
        agentId,
        threadId,
        errors: turn.errors,
      });
    }

    const text = turn.finalMessage?.trim();
    if (!text) {
      log.info("SMS per-turn spawn produced no text — skipping delivery", { agentId, threadId });
      return;
    }

    const workResult: WorkResult = {
      text,
      agentId,
      workItem,
      costUsd: turn.usage.costUsd,
      durationMs: turn.usage.durationMs,
      error: turn.errors[0],
    };
    await this.deliver(workResult);
  }

  private async quoApi(path: string, params: Record<string, string> = {}): Promise<any> {
    const url = new URL(`${QUO_BASE}${path}`);
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.append(k, v);
    }
    const res = await fetch(url.toString(), {
      headers: { Authorization: this.apiKey },
    });
    if (!res.ok) throw new Error(`Quo API ${res.status}: ${await res.text()}`);
    return res.json();
  }

  private async poll(onWorkItem: (item: WorkItem) => void): Promise<void> {
    for (const line of this.lines) {
      try {
        // Get recent conversations with new activity
        const convResult = await this.quoApi("/conversations", {
          "phoneNumbers[]": line.id,
          updatedAfter: line.lastSeen,
          maxResults: "20",
        });

        const conversations = convResult.data ?? [];
        if (conversations.length === 0) continue;

        for (const conv of conversations) {
          const participant = conv.participants?.[0];
          if (!participant) continue;

          const msgResult = await this.quoApi("/messages", {
            phoneNumberId: line.id,
            "participants[]": participant,
            maxResults: "10",
            createdAfter: line.lastSeen,
          });

          const messages: QuoMessage[] = (msgResult.data ?? [])
            .filter((m: any) => m.direction === "incoming")
            .reverse(); // chronological order

          for (const msg of messages) {
            if (!msg.text) continue;

            const smsText = `SMS from ${msg.from} \u2192 ${line.label}:\n${msg.text}`;

            const workItem: WorkItem = {
              id: msg.id,
              text: smsText,
              source: {
                kind: "sms",
                id: line.id,
                label: line.routeLabel,
              },
              sender: msg.from,
              threadId: `sms:${line.id}:${msg.from}`,
              timestamp: new Date(),
              meta: {
                quoMessageId: msg.id,
                lineNumber: line.number,
              },
            };

            log.info("SMS received", {
              from: msg.from,
              line: line.label,
              textLength: msg.text.length,
            });

            if (this.perTurn?.perTurnSpawnEnabled) {
              this.spawnTurnForWorkItem(workItem).catch((err) => {
                log.error("SMS per-turn spawn failed", {
                  error: String(err),
                  from: msg.from,
                  line: line.label,
                });
              });
            } else {
              onWorkItem(workItem);
            }
          }
        }

        // Update last seen to now
        line.lastSeen = new Date().toISOString();
      } catch (err) {
        log.error("SMS poll failed", { line: line.label, error: String(err) });
      }
    }
  }
}
