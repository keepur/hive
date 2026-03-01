import { createLogger } from "../../logging/logger.js";
import type { MessageRouter } from "../../slack/message-router.js";
import type { SlackGateway } from "../../slack/slack-gateway.js";
import type { IncomingMessage } from "../../types/agent-config.js";

const log = createLogger("sms-poller");

const QUO_BASE = "https://api.openphone.com/v1";

interface QuoLine {
  phoneNumberId: string;
  label: string;
  slackChannel: string; // channel name where Rae sees these
  lastSeen: string; // ISO 8601 timestamp of last seen message
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

export class SmsPoller {
  private lines: QuoLine[] = [];
  private interval: ReturnType<typeof setInterval> | null = null;
  private apiKey: string;
  private router: MessageRouter;
  private gateway: SlackGateway;
  private slackChannelIds = new Map<string, string>(); // name → id
  /** Slack timestamps of messages we posted — gateway should ignore these */
  private postedTs = new Set<string>();

  constructor(apiKey: string, router: MessageRouter, gateway: SlackGateway) {
    this.apiKey = apiKey;
    this.router = router;
    this.gateway = gateway;
  }

  addLine(phoneNumberId: string, label: string, slackChannel: string): void {
    this.lines.push({
      phoneNumberId,
      label,
      slackChannel,
      lastSeen: new Date().toISOString(),
    });
    log.info("SMS poller watching line", { phoneNumberId, label, slackChannel });
  }

  async start(intervalMs = 30_000): Promise<void> {
    if (this.lines.length === 0) {
      log.warn("SMS poller has no lines to watch");
      return;
    }

    // Resolve slack channel names to IDs
    for (const line of this.lines) {
      const id = await this.resolveChannelId(line.slackChannel);
      if (id) {
        this.slackChannelIds.set(line.slackChannel, id);
      } else {
        log.warn("Could not resolve Slack channel for SMS poller", { channel: line.slackChannel });
      }
    }

    this.interval = setInterval(() => this.poll(), intervalMs);
    log.info("SMS poller started", { intervalMs, lines: this.lines.map((l) => l.label) });
  }

  /** Check if a Slack message timestamp was posted by this poller */
  isPollerMessage(ts: string): boolean {
    return this.postedTs.has(ts);
  }

  stop(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async resolveChannelId(name: string): Promise<string | undefined> {
    try {
      const res = await this.gateway.client.conversations.list({ types: "public_channel", limit: 200 });
      const ch = (res.channels ?? []).find((c: any) => c.name === name);
      return ch?.id;
    } catch {
      return undefined;
    }
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

  private async poll(): Promise<void> {
    for (const line of this.lines) {
      try {
        // Get recent conversations to find ones with new activity
        const convResult = await this.quoApi("/conversations", {
          "phoneNumbers[]": line.phoneNumberId,
          updatedAfter: line.lastSeen,
          maxResults: "20",
        });

        const conversations = convResult.data ?? [];
        if (conversations.length === 0) continue;

        for (const conv of conversations) {
          // Get messages for this conversation
          const participant = conv.participants?.[0];
          if (!participant) continue;

          const msgResult = await this.quoApi("/messages", {
            phoneNumberId: line.phoneNumberId,
            "participants[]": participant,
            maxResults: "10",
            createdAfter: line.lastSeen,
          });

          const messages: QuoMessage[] = (msgResult.data ?? [])
            .filter((m: any) => m.direction === "incoming")
            .reverse(); // chronological order

          for (const msg of messages) {
            if (!msg.text) continue;

            const channelId = this.slackChannelIds.get(line.slackChannel);
            if (!channelId) continue;

            // Format the SMS for Slack and the agent
            const smsText = `SMS from ${msg.from} → ${line.label}:\n${msg.text}`;

            // Post to Slack channel so the team can see it
            const slackTs = await this.gateway.postMessage(
              channelId,
              smsText,
              undefined,
              { name: "Quo", icon: ":phone:" },
            );

            // Track this ts so the gateway doesn't re-route it.
            // Slack echoes the event within seconds, so expire after 60s.
            if (slackTs) {
              this.postedTs.add(slackTs);
              setTimeout(() => this.postedTs.delete(slackTs), 60_000);
            }

            // Route to the agent watching this channel
            const incomingMsg: IncomingMessage = {
              text: smsText,
              channel: channelId,
              channelName: line.slackChannel,
              user: "quo-integration",
              ts: slackTs ?? Date.now().toString(),
              threadTs: slackTs, // agent replies in this thread
            };

            log.info("SMS received", { from: msg.from, line: line.label, textLength: msg.text.length });
            this.router.route(incomingMsg, this.gateway);
          }
        }

        // Update last seen to now
        line.lastSeen = new Date().toISOString();
      } catch (err) {
        log.error("SMS poller failed", { line: line.label, error: String(err) });
      }
    }
  }
}
