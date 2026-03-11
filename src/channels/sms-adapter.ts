import { createLogger } from "../logging/logger.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { WorkItem, WorkResult, ChannelKind } from "../types/work-item.js";

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

export class SmsAdapter implements ChannelAdapter {
  readonly id: string = "sms";
  readonly kind: ChannelKind = "sms";

  private apiKey: string;
  private lines: SmsLine[];
  private interval: ReturnType<typeof setInterval> | null = null;

  constructor(apiKey: string, lines: Array<{ id: string; label: string; number: string; slackChannel?: string }>) {
    this.apiKey = apiKey;
    this.lines = lines.map((l) => ({
      id: l.id,
      label: l.label,
      number: l.number,
      routeLabel: l.slackChannel ?? l.label,
      lastSeen: new Date().toISOString(),
    }));
  }

  async start(onWorkItem: (item: WorkItem) => void): Promise<void> {
    if (this.lines.length === 0) {
      log.warn("SMS adapter has no lines to watch");
      return;
    }

    // Poll immediately, then every 30 seconds
    this.poll(onWorkItem);
    this.interval = setInterval(() => this.poll(onWorkItem), 30_000);
    log.info("SMS adapter started", { lines: this.lines.map((l) => l.label) });
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

            onWorkItem(workItem);
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
