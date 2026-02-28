import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { createLogger } from "../logging/logger.js";
import type { IncomingMessage } from "../types/agent-config.js";

const log = createLogger("slack-gateway");

type MessageHandler = (msg: IncomingMessage) => void;

export class SlackGateway {
  private socket: SocketModeClient;
  private web: WebClient;
  private handler: MessageHandler | null = null;
  private botUserId: string | null = null;

  constructor(appToken: string, botToken: string) {
    this.socket = new SocketModeClient({ appToken });
    this.web = new WebClient(botToken);
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }

  async start(): Promise<void> {
    // Get bot user ID so we can ignore our own messages
    const auth = await this.web.auth.test();
    this.botUserId = auth.user_id as string;
    log.info("Bot identity resolved", { botUserId: this.botUserId });

    this.socket.on("message", async ({ event, body, ack }) => {
      await ack();

      // Skip bot's own messages, message_changed events, etc.
      if (!event || event.bot_id || event.subtype || event.user === this.botUserId) {
        return;
      }

      const msg: IncomingMessage = {
        text: event.text ?? "",
        channel: event.channel,
        user: event.user,
        ts: event.ts,
        threadTs: event.thread_ts,
      };

      log.info("Message received", {
        channel: msg.channel,
        user: msg.user,
        textLength: msg.text.length,
      });

      if (this.handler) {
        this.handler(msg);
      }
    });

    await this.socket.start();
    log.info("Socket Mode connected");
  }

  async stop(): Promise<void> {
    await this.socket.disconnect();
    log.info("Socket Mode disconnected");
  }

  async postMessage(channel: string, text: string, threadTs?: string): Promise<string | undefined> {
    const result = await this.web.chat.postMessage({
      channel,
      text,
      thread_ts: threadTs,
      unfurl_links: false,
    });
    return result.ts;
  }

  async addReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.web.reactions.add({ channel, name: emoji, timestamp: ts });
    } catch (err) {
      // Ignore "already_reacted" errors
      const msg = String(err);
      if (!msg.includes("already_reacted")) {
        log.warn("Failed to add reaction", { channel, ts, emoji, error: msg });
      }
    }
  }

  async removeReaction(channel: string, ts: string, emoji: string): Promise<void> {
    try {
      await this.web.reactions.remove({ channel, name: emoji, timestamp: ts });
    } catch {
      // Ignore errors on removal
    }
  }

  async updateMessage(channel: string, ts: string, text: string): Promise<void> {
    await this.web.chat.update({ channel, ts, text });
  }

  get client(): WebClient {
    return this.web;
  }
}
