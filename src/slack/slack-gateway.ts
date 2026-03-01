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
  private botId: string | null = null; // bot_id (Bxxx) — different from user_id (Uxxx)
  private channelNameCache = new Map<string, string>(); // id → name
  private integrationChannels = new Set<string>(); // channel names that accept bot messages
  private ignoreTs: ((ts: string) => boolean) | null = null; // skip messages posted by e.g. SMS poller

  constructor(appToken: string, botToken: string) {
    this.socket = new SocketModeClient({ appToken });
    this.web = new WebClient(botToken);
  }

  addIntegrationChannels(channels: string[]): void {
    for (const ch of channels) this.integrationChannels.add(ch);
  }

  /** Register a filter — if it returns true for a message ts, skip that message */
  setIgnoreFilter(fn: (ts: string) => boolean): void {
    this.ignoreTs = fn;
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
    this.botId = auth.bot_id as string ?? null;
    log.info("Bot identity resolved", { botUserId: this.botUserId, botId: this.botId });

    // Standard message events
    this.socket.on("message", async ({ event, ack }) => {
      await ack();
      if (!event) return;

      // Log raw events for debugging
      log.debug("Raw message event", {
        subtype: event.subtype,
        bot_id: event.bot_id,
        user: event.user,
        channel: event.channel,
        hasText: !!event.text,
        text: event.text?.slice(0, 100),
        hasAttachments: !!event.attachments?.length,
        hasBlocks: !!event.blocks?.length,
        attachmentFallback: event.attachments?.[0]?.fallback?.slice(0, 100),
      });

      // Skip our own bot's messages (by user ID or bot ID)
      if (event.user === this.botUserId) return;
      if (event.bot_id && event.bot_id === this.botId) return;

      // Skip messages posted by internal systems (e.g. SMS poller) that route directly
      if (event.ts && this.ignoreTs?.(event.ts)) return;

      // For bot messages or messages with subtypes, only allow in integration channels
      if (event.bot_id || event.subtype) {
        const channelName = await this.resolveChannelName(event.channel);
        if (!this.integrationChannels.has(channelName)) return;
        log.info("Integration message accepted", { channelName, subtype: event.subtype, bot_id: event.bot_id });
      }

      const channelName = await this.resolveChannelName(event.channel);

      // Extract text — bot_message subtypes may carry text in attachments or blocks
      let text = event.text ?? "";
      if (!text) {
        // Collect all blocks — both top-level and inside attachments
        const allBlocks: any[] = [...(event.blocks ?? [])];
        for (const att of event.attachments ?? []) {
          if (att.blocks) allBlocks.push(...att.blocks);
          if (att.text) text += att.text + "\n";
        }

        if (!text) {
          text = allBlocks
            .filter((b: any) => b.type === "section" || b.type === "rich_text")
            .map((b: any) => {
              if (b.text?.text) return b.text.text;
              if (b.elements) return b.elements.map((e: any) =>
                e.elements?.map((el: any) => el.text || "").join("") ?? ""
              ).join("\n");
              return "";
            })
            .filter(Boolean)
            .join("\n");
        }

        text = text.trim();
      }

      if (!text) {
        log.debug("Skipping message with no extractable text", { channel: event.channel, channelName });
        return;
      }

      const msg: IncomingMessage = {
        text,
        channel: event.channel,
        channelName,
        user: event.user ?? event.bot_id ?? "unknown",
        ts: event.ts,
        threadTs: event.thread_ts,
      };

      log.info("Message received", { channel: msg.channel, channelName, user: msg.user, textLength: msg.text.length });
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

    // Catch-all: log every event type for debugging
    this.socket.on("slack_event", async ({ ack, body }) => {
      await ack();
      const event = body?.event;
      if (event) {
        log.debug("slack_event", { type: event.type, subtype: event.subtype, channel: event.channel });
      }
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

  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
    identity?: { name: string; icon?: string },
  ): Promise<string | undefined> {
    // Try with agent identity first, fall back to plain bot post
    if (identity) {
      try {
        const iconOpts: Record<string, string> = {};
        if (identity.icon) {
          if (identity.icon.startsWith(":") && identity.icon.endsWith(":")) {
            iconOpts.icon_emoji = identity.icon;
          } else {
            iconOpts.icon_url = identity.icon;
          }
        }

        const result = await this.web.chat.postMessage({
          channel,
          text,
          thread_ts: threadTs,
          unfurl_links: false,
          username: identity.name,
          ...iconOpts,
        });
        return result.ts;
      } catch (err) {
        log.warn("Failed to post with identity, falling back to plain post", { error: String(err) });
      }
    }

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

  private async resolveChannelName(channelId: string): Promise<string> {
    const cached = this.channelNameCache.get(channelId);
    if (cached) return cached;

    try {
      const result = await this.web.conversations.info({ channel: channelId });
      const name = (result.channel as any)?.name ?? channelId;
      this.channelNameCache.set(channelId, name);
      return name;
    } catch {
      // DMs and some channels don't have names — use the ID
      this.channelNameCache.set(channelId, channelId);
      return channelId;
    }
  }

  get client(): WebClient {
    return this.web;
  }
}
