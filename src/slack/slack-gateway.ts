import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import { createLogger } from "../logging/logger.js";
import type { IncomingMessage } from "../types/agent-config.js";

const log = createLogger("slack-gateway");

type MessageHandler = (msg: IncomingMessage) => void;

export interface ThreadStartedEvent {
  channel: string;
  threadTs: string;
  context: { channelId?: string; teamId?: string; enterpriseId?: string };
}

export interface ThreadContextChangedEvent {
  channel: string;
  threadTs: string;
  context: { channelId?: string; teamId?: string; enterpriseId?: string };
}

type ThreadStartedHandler = (event: ThreadStartedEvent) => void;
type ThreadContextHandler = (event: ThreadContextChangedEvent) => void;

export class SlackGateway {
  private socket: SocketModeClient;
  private web: WebClient;
  private messageHandler: MessageHandler | null = null;
  private threadStartedHandler: ThreadStartedHandler | null = null;
  private threadContextHandler: ThreadContextHandler | null = null;
  private botUserId: string | null = null;

  constructor(appToken: string, botToken: string) {
    this.socket = new SocketModeClient({ appToken });
    this.web = new WebClient(botToken);
  }

  onMessage(handler: MessageHandler): void {
    this.messageHandler = handler;
  }

  onThreadStarted(handler: ThreadStartedHandler): void {
    this.threadStartedHandler = handler;
  }

  onThreadContextChanged(handler: ThreadContextHandler): void {
    this.threadContextHandler = handler;
  }

  async start(): Promise<void> {
    const auth = await this.web.auth.test();
    this.botUserId = auth.user_id as string;
    log.info("Bot identity resolved", { botUserId: this.botUserId });

    // Standard message events
    this.socket.on("message", async ({ event, ack }) => {
      await ack();
      if (!event || event.bot_id || event.subtype || event.user === this.botUserId) return;

      const msg: IncomingMessage = {
        text: event.text ?? "",
        channel: event.channel,
        user: event.user,
        ts: event.ts,
        threadTs: event.thread_ts,
      };

      log.info("Message received", { channel: msg.channel, user: msg.user, textLength: msg.text.length });
      this.messageHandler?.(msg);
    });

    // Assistant thread started — user opened the AI app panel
    this.socket.on("assistant_thread_started", async ({ event, ack }) => {
      await ack();
      log.info("Assistant thread started", { channel: event?.assistant_thread?.channel_id });

      const thread = event?.assistant_thread;
      if (!thread) return;

      this.threadStartedHandler?.({
        channel: thread.channel_id,
        threadTs: thread.thread_ts,
        context: thread.context ?? {},
      });
    });

    // Assistant thread context changed — user switched channels
    this.socket.on("assistant_thread_context_changed", async ({ event, ack }) => {
      await ack();
      log.info("Assistant thread context changed", { channel: event?.assistant_thread?.channel_id });

      const thread = event?.assistant_thread;
      if (!thread) return;

      this.threadContextHandler?.({
        channel: thread.channel_id,
        threadTs: thread.thread_ts,
        context: thread.context ?? {},
      });
    });

    await this.socket.start();
    log.info("Socket Mode connected");
  }

  async stop(): Promise<void> {
    await this.socket.disconnect();
    log.info("Socket Mode disconnected");
  }

  // --- Assistant thread methods ---

  async setThreadStatus(channel: string, threadTs: string, status: string): Promise<void> {
    try {
      await this.web.assistant.threads.setStatus({ channel_id: channel, thread_ts: threadTs, status });
    } catch (err) {
      log.warn("Failed to set thread status", { error: String(err) });
    }
  }

  async setSuggestedPrompts(
    channel: string,
    threadTs: string,
    prompts: Array<{ title: string; message: string }>,
  ): Promise<void> {
    try {
      await this.web.assistant.threads.setSuggestedPrompts({
        channel_id: channel,
        thread_ts: threadTs,
        prompts,
      });
    } catch (err) {
      log.warn("Failed to set suggested prompts", { error: String(err) });
    }
  }

  async setThreadTitle(channel: string, threadTs: string, title: string): Promise<void> {
    try {
      await this.web.assistant.threads.setTitle({ channel_id: channel, thread_ts: threadTs, title });
    } catch (err) {
      log.warn("Failed to set thread title", { error: String(err) });
    }
  }

  // --- Streaming methods ---
  // startStream returns { channel, ts } — appendStream and stopStream use those same values

  async startStream(channel: string, threadTs: string): Promise<{ channel: string; ts: string } | undefined> {
    try {
      const result = await this.web.chat.startStream({
        channel,
        thread_ts: threadTs,
      });
      if (result.channel && result.ts) {
        return { channel: result.channel, ts: result.ts };
      }
      return undefined;
    } catch (err) {
      log.warn("Failed to start stream", { error: String(err) });
      return undefined;
    }
  }

  async appendStream(channel: string, ts: string, text: string): Promise<void> {
    try {
      await this.web.chat.appendStream({ channel, ts, markdown_text: text });
    } catch (err) {
      log.warn("Failed to append stream", { error: String(err) });
    }
  }

  async stopStream(channel: string, ts: string): Promise<void> {
    try {
      await this.web.chat.stopStream({ channel, ts });
    } catch (err) {
      log.warn("Failed to stop stream", { error: String(err) });
    }
  }

  // --- Standard messaging ---

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

  get client(): WebClient {
    return this.web;
  }
}
