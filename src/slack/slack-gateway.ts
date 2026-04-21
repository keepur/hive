import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { ConversationsHistoryResponse, UsersInfoResponse } from "@slack/web-api";
import { createLogger } from "../logging/logger.js";
import type { IncomingMessage } from "../types/agent-config.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import { downloadAndProcess, type SlackFile, type ProcessedFile } from "../files/file-processor.js";
import { OutboundTsCache } from "./outbound-ts-cache.js";

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
  private peerBotUserIds = new Set<string>(); // bot user IDs from other gateways
  private peerBotIds = new Set<string>(); // bot IDs (Bxxx) from other gateways
  private channelNameCache = new Map<string, string>(); // id → name
  private channelIdCache = new Map<string, string>(); // name → id (inverse of channelNameCache, lazy-populated)
  private userNameCache = new Map<string, string>(); // userId → display name
  private outboundTsCache = new OutboundTsCache();
  private integrationChannels = new Set<string>(); // channel names that accept bot messages
  private botToken: string;

  constructor(appToken: string, botToken: string) {
    this.socket = new SocketModeClient({ appToken });
    this.web = new WebClient(botToken);
    this.botToken = botToken;
  }

  addIntegrationChannels(channels: string[]): void {
    for (const ch of channels) this.integrationChannels.add(ch);
  }

  /** Register bot identities from peer gateways so we can filter their messages too */
  addPeerBotIds(botUserId: string | null, botId: string | null): void {
    if (botUserId) this.peerBotUserIds.add(botUserId);
    if (botId) this.peerBotIds.add(botId);
    log.info("Peer bot IDs registered", {
      peerBotUserIds: [...this.peerBotUserIds],
      peerBotIds: [...this.peerBotIds],
    });
  }

  /** Expose resolved bot identity for cross-gateway registration */
  get resolvedBotUserId(): string | null {
    return this.botUserId;
  }
  get resolvedBotId(): string | null {
    return this.botId;
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
    this.botId = (auth.bot_id as string) ?? null;
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
        hasAttachments: !!event.attachments?.length,
        hasBlocks: !!event.blocks?.length,
      });

      // Skip messages from any Hive bot (own + peer gateways)
      if (event.user === this.botUserId) return;
      if (this.peerBotUserIds.has(event.user)) return;
      if (event.bot_id && event.bot_id === this.botId) return;
      if (event.bot_id && this.peerBotIds.has(event.bot_id)) return;

      // Suppress self-echoes from agent-initiated sends routed through the local Slack API.
      if (event.ts && event.channel && this.outboundTsCache.has(event.channel, event.ts)) {
        log.info("Outbound echo suppressed", { channel: event.channel, ts: event.ts });
        return;
      }

      // For bot messages or messages with subtypes, only allow in integration channels
      if (event.bot_id || event.subtype) {
        const channelName = await this.resolveChannelName(event.channel);
        if (!this.integrationChannels.has(channelName)) {
          log.info("Message filtered (subtype/bot in non-integration channel)", {
            channel: event.channel,
            channelName,
            user: event.user,
            subtype: event.subtype,
            bot_id: event.bot_id,
            hasText: !!event.text,
          });
          return;
        }
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
              if (b.elements)
                return b.elements
                  .map((e: any) => e.elements?.map((el: any) => el.text || "").join("") ?? "")
                  .join("\n");
              return "";
            })
            .filter(Boolean)
            .join("\n");
        }

        text = text.trim();
      }

      // Process file attachments
      let processedFiles: ProcessedFile[] = [];
      if (event.files?.length) {
        log.info("Processing file attachments", {
          count: event.files.length,
          names: event.files.map((f: any) => f.name),
        });
        const results = await Promise.all(
          event.files.map((f: any) => downloadAndProcess(f as SlackFile, this.botToken)),
        );
        processedFiles = results.filter(Boolean) as ProcessedFile[];
      }

      if (!text && processedFiles.length === 0) {
        log.info("Skipping message with no extractable text or files", {
          channel: event.channel,
          channelName,
          user: event.user,
          subtype: event.subtype,
          hasBlocks: !!event.blocks?.length,
          hasAttachments: !!event.attachments?.length,
          blockTypes: event.blocks?.map((b: any) => b.type),
        });
        return;
      }

      // Default text for file-only messages
      if (!text && processedFiles.length > 0) {
        text = `[shared ${processedFiles.length} file${processedFiles.length > 1 ? "s" : ""}]`;
      }

      // Resolve <@USERID> mentions to @displayname for readable text and name-based routing
      text = await this.resolveUserMentions(text);

      const msg: IncomingMessage = {
        text,
        channel: event.channel,
        channelName,
        user: event.user ?? event.bot_id ?? "unknown",
        ts: event.ts,
        threadTs: event.thread_ts,
        files: processedFiles.length > 0 ? processedFiles : undefined,
      };

      log.info("Message received", {
        channel: msg.channel,
        channelName,
        user: msg.user,
        textLength: msg.text.length,
        fileCount: processedFiles.length,
      });
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

  // Length thresholds for message handling
  private static readonly SLACK_MAX_CHARS = 3900; // below Slack's ~4K collapse threshold
  private static readonly SPLIT_MAX_CHARS = 8000; // above this, use file upload instead of splitting
  private static readonly SUMMARY_LENGTH = 200; // chars of original text to include in file upload summary

  async postMessage(
    channel: string,
    text: string,
    threadTs?: string,
    identity?: { name: string; icon?: string },
  ): Promise<string | undefined> {
    if (text.length <= SlackGateway.SLACK_MAX_CHARS) {
      return this.postSingle(channel, text, threadTs, identity);
    }

    if (text.length <= SlackGateway.SPLIT_MAX_CHARS) {
      return this.postSplit(channel, text, threadTs, identity);
    }

    return this.postAsFile(channel, text, threadTs, identity);
  }

  private async postSingle(
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
        if (result.ok && result.ts && result.channel) {
          this.outboundTsCache.register(result.channel, result.ts);
        }
        return result.ts;
      } catch (err) {
        log.warn("Failed to post with identity, falling back to plain post", { error: String(err) });
      }
    }

    try {
      const result = await this.web.chat.postMessage({
        channel,
        text,
        thread_ts: threadTs,
        unfurl_links: false,
      });
      if (result.ok && result.ts && result.channel) {
        this.outboundTsCache.register(result.channel, result.ts);
      }
      return result.ts;
    } catch (err) {
      log.error("Failed to post message", { channel, error: String(err) });
      return undefined;
    }
  }

  private splitText(text: string): string[] {
    const maxLen = SlackGateway.SLACK_MAX_CHARS;
    const chunks: string[] = [];
    let remaining = text;

    while (remaining.length > maxLen) {
      let splitAt = -1;

      // Priority 1: double newline (paragraph break)
      const doubleNl = remaining.lastIndexOf("\n\n", maxLen);
      if (doubleNl > 0) {
        splitAt = doubleNl + 2; // include the double newline in current chunk boundary
      }

      // Priority 2: single newline
      if (splitAt === -1) {
        const singleNl = remaining.lastIndexOf("\n", maxLen);
        if (singleNl > 0) {
          splitAt = singleNl + 1;
        }
      }

      // Priority 3: space (word boundary)
      if (splitAt === -1) {
        const space = remaining.lastIndexOf(" ", maxLen);
        if (space > 0) {
          splitAt = space + 1;
        }
      }

      // Priority 4: hard cut
      if (splitAt === -1) {
        splitAt = maxLen;
      }

      chunks.push(remaining.slice(0, splitAt).trimEnd());
      remaining = remaining.slice(splitAt).trimStart();
    }

    if (remaining.length > 0) {
      chunks.push(remaining);
    }

    return chunks;
  }

  private async postSplit(
    channel: string,
    text: string,
    threadTs?: string,
    identity?: { name: string; icon?: string },
  ): Promise<string | undefined> {
    const chunks = this.splitText(text);
    log.info("Splitting oversized message", { channel, totalLength: text.length, chunks: chunks.length });

    let firstTs: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = i === 0 ? chunks[i] : `_(cont.)_ ${chunks[i]}`;
      const ts = await this.postSingle(channel, chunk, threadTs, identity);
      if (i === 0) firstTs = ts;
    }
    return firstTs;
  }

  private async postAsFile(
    channel: string,
    text: string,
    threadTs?: string,
    identity?: { name: string; icon?: string },
  ): Promise<string | undefined> {
    // Build summary: first SUMMARY_LENGTH chars, trimmed to last complete sentence or line break
    const summaryRaw = text.slice(0, SlackGateway.SUMMARY_LENGTH);
    let summary = summaryRaw;
    // Try to trim to last sentence boundary
    const sentenceEnd = Math.max(
      summaryRaw.lastIndexOf(". "),
      summaryRaw.lastIndexOf(".\n"),
      summaryRaw.lastIndexOf("?\n"),
      summaryRaw.lastIndexOf("? "),
      summaryRaw.lastIndexOf("!\n"),
      summaryRaw.lastIndexOf("! "),
    );
    if (sentenceEnd > 0) {
      summary = summaryRaw.slice(0, sentenceEnd + 1);
    } else {
      // Fall back to last line break
      const lineEnd = summaryRaw.lastIndexOf("\n");
      if (lineEnd > 0) {
        summary = summaryRaw.slice(0, lineEnd);
      }
    }
    summary = `${summary.trimEnd()}\n\n_(full response attached)_`;

    const agentName = identity?.name ?? "hive";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const filename = `${agentName.toLowerCase()}-${timestamp}.md`;

    // Post summary message first for context
    const summaryTs = await this.postSingle(channel, summary, threadTs, identity);

    // Upload full text as .md file
    try {
      const baseArgs = { content: text, filename, title: `${agentName} response` };
      const destination = threadTs ? { channel_id: channel, thread_ts: threadTs } : { channel_id: channel };
      await this.web.files.uploadV2({ ...baseArgs, ...destination });
      log.info("Uploaded oversized message as file", { channel, filename, length: text.length });
      return summaryTs;
    } catch (err) {
      log.warn("File upload failed, falling back to split", { channel, error: String(err) });
      // Fallback: split the remaining text (summary already posted)
      return this.postSplit(channel, text, threadTs, identity);
    }
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

  /** Resolve a Slack user ID to display name */
  async resolveUserName(userId: string): Promise<string> {
    let name = this.userNameCache.get(userId);
    if (name) return name;
    try {
      const result = await this.web.users.info({ user: userId });
      name = result.user?.profile?.display_name || result.user?.real_name || result.user?.name || userId;
      this.userNameCache.set(userId, name);
      return name;
    } catch {
      this.userNameCache.set(userId, userId);
      return userId;
    }
  }

  /** Replace <@USERID> mentions with @displayname so downstream consumers see readable names */
  async resolveUserMentions(text: string): Promise<string> {
    const mentionPattern = /<@(U[A-Z0-9]+)>/g;
    const mentions = [...text.matchAll(mentionPattern)];
    if (mentions.length === 0) return text;

    let resolved = text;
    for (const match of mentions) {
      const userId = match[1];
      let name = this.userNameCache.get(userId);
      if (!name) {
        try {
          const result = await this.web.users.info({ user: userId });
          name = result.user?.profile?.display_name || result.user?.real_name || result.user?.name || userId;
          this.userNameCache.set(userId, name);
        } catch {
          this.userNameCache.set(userId, userId);
          continue;
        }
      }
      resolved = resolved.replace(match[0], `@${name}`);
    }
    return resolved;
  }

  registerOutboundTs(channel: string, ts: string): void {
    this.outboundTsCache.register(channel, ts);
  }

  isOutboundEcho(channel: string, ts: string): boolean {
    return this.outboundTsCache.has(channel, ts);
  }

  /**
   * Public entry for the Slack internal HTTP API. Delegates to `postMessage`, which picks
   * `postSingle` / `postSplit` / `postAsFile` based on text length and funnels into `postSingle`
   * where the cache write happens. Returns the first chunk's ts (sufficient for the caller —
   * every chunk's ts is registered independently).
   */
  async postAndRegister(
    channel: string,
    text: string,
    threadTs?: string,
  ): Promise<{ ok: boolean; ts?: string; channel?: string; error?: string }> {
    try {
      const ts = await this.postMessage(channel, text, threadTs);
      if (ts) return { ok: true, ts, channel };
      return { ok: false, error: "postMessage returned no ts" };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Resolve a channel name or ID to a Slack channel ID.
   * - Inputs starting with C, D, or G are returned unchanged (already an ID).
   * - Otherwise looks up via channelIdCache (lazy-populated from conversations.list).
   * - Returns null if the channel name cannot be resolved.
   */
  async resolveChannelId(nameOrId: string): Promise<string | null> {
    if (nameOrId.startsWith("C") || nameOrId.startsWith("D") || nameOrId.startsWith("G")) {
      return nameOrId;
    }
    const name = nameOrId.replace(/^#/, "");
    const cached = this.channelIdCache.get(name);
    if (cached) return cached;
    try {
      // Fetch via conversations.list, populate both caches as we see entries.
      let cursor: string | undefined;
      do {
        const res = await this.web.conversations.list({
          limit: 1000,
          cursor,
          exclude_archived: true,
          types: "public_channel,private_channel",
        });
        for (const ch of (res.channels as Array<{ id?: string; name?: string }>) ?? []) {
          if (ch.id && ch.name) {
            this.channelNameCache.set(ch.id, ch.name);
            this.channelIdCache.set(ch.name, ch.id);
          }
        }
        cursor = (res as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      log.warn("channel id resolve failed", { name, error: (err as Error).message });
      return null;
    }
    return this.channelIdCache.get(name) ?? null;
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

  /**
   * Read recent messages from a channel. Used by the Slack internal HTTP API.
   * Returns the messages array from conversations.history, or undefined on error.
   */
  async readChannel(channel: string, limit = 50): Promise<ConversationsHistoryResponse["messages"] | undefined> {
    try {
      const res = await this.web.conversations.history({ channel, limit });
      return res.messages;
    } catch (err) {
      log.warn("readChannel failed", { channel, error: (err as Error).message });
      return undefined;
    }
  }

  /**
   * List channels, optionally filtered by a substring query on the name.
   * Used by the Slack internal HTTP API.
   */
  async listChannels(query?: string): Promise<Array<{ id: string; name: string }>> {
    const results: Array<{ id: string; name: string }> = [];
    try {
      let cursor: string | undefined;
      do {
        const res = await this.web.conversations.list({
          limit: 1000,
          cursor,
          exclude_archived: true,
          types: "public_channel,private_channel",
        });
        for (const ch of (res.channels as Array<{ id?: string; name?: string }>) ?? []) {
          if (ch.id && ch.name) {
            // Populate the name/id caches as a side-effect
            this.channelNameCache.set(ch.id, ch.name);
            this.channelIdCache.set(ch.name, ch.id);
            if (!query || ch.name.includes(query)) {
              results.push({ id: ch.id, name: ch.name });
            }
          }
        }
        cursor = (res as { response_metadata?: { next_cursor?: string } }).response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      log.warn("listChannels failed", { query, error: (err as Error).message });
    }
    return results;
  }

  /**
   * Look up a Slack user by user ID. Used by the Slack internal HTTP API.
   * Returns the user object, or undefined on error.
   */
  async readUser(user: string): Promise<UsersInfoResponse["user"] | undefined> {
    try {
      const res = await this.web.users.info({ user });
      return res.user;
    } catch (err) {
      log.warn("readUser failed", { user, error: (err as Error).message });
      return undefined;
    }
  }

  sweep(): SweepResult {
    const pruned = this.channelNameCache.size + this.channelIdCache.size + this.userNameCache.size;
    this.channelNameCache.clear();
    this.channelIdCache.clear();
    this.userNameCache.clear();
    return { component: "slack-gateway", pruned, retried: 0, bytesFreed: 0, errors: [] };
  }

  get client(): WebClient {
    return this.web;
  }
}
