import { SocketModeClient } from "@slack/socket-mode";
import { WebClient } from "@slack/web-api";
import type { UsersInfoResponse, WebClientOptions } from "@slack/web-api";
import { createLogger } from "../logging/logger.js";
import type { IncomingMessage } from "../types/agent-config.js";
import type { NoticeDestination, NoticeLookupGate, SendResult } from "../admin/model-catalog-notification.js";
import type { SweepResult } from "../sweeper/sweeper.js";
import { downloadAndProcess, type SlackFile, type ProcessedFile } from "../files/file-processor.js";
import { OutboundTsCache } from "./outbound-ts-cache.js";
import {
  classifyNoticeError,
  classifyNoticeResponse,
  noticeClientOptions,
  validatedNoticeFetch,
} from "./slack-notification-receipt.js";

const log = createLogger("slack-gateway");

/**
 * KPR-492 D2: a per-call sink that carries the real Slack error out of
 * `postSingle`'s catch. Deliberately NOT the `lastReadError` instance-field
 * precedent (`:54`): reads are one-at-a-time per tool call, but posts fan out
 * (meeting mode, conference rounds, cron bursts), and an error string
 * attributed to the wrong agent's tool result is worse than a generic one.
 * `postAndRegister` allocates a fresh sink per call.
 *
 * Multi-write on one sink is safe and intentional. A single `postAndRegister`
 * can drive `postSingle` more than once against the same sink: `postSplit`
 * posts every chunk (`:505`), and `postAsFile`'s upload catch falls back to
 * `postSplit` AFTER the summary post already ran (`:554-558`). Last-write-wins
 * is correct because `postAndRegister` reads the sink ONLY when `ts === undefined`
 * — i.e. only when nothing landed at all — so the string the agent sees always
 * describes a genuinely-failed send. No ordering discipline, no per-chunk array.
 */
export interface PostErrorSink {
  error?: string;
}

/** KPR-492 D4: resolution result for a send/read target. No `kind` discriminator — it had no reader (spec D4). */
export type ResolvedConversation = { ok: true; id: string } | { ok: false; error: string };
/** KPR-492 D4: resolution result for a user handle / id. */
export type ResolvedUser = { ok: true; id: string } | { ok: false; error: string };

/**
 * KPR-492 D4 rung 0: Slack's own mention encodings, unwrapped purely
 * syntactically before the shape rungs run. `slack_read_channel` returns raw
 * `conversations.history` objects (`readChannel`, `:798-799`), so an agent that
 * reads a thread and then DMs the person it saw mentioned hands us `<@U0123>`
 * verbatim — the exact flow this ticket serves. In-repo regex precedent:
 * `resolveUserMentions` (`:597`, `/<@(U[A-Z0-9]+)>/g`). Group 1 is the id.
 */
const MENTION_USER = /^<@([UW][A-Z0-9]+)(?:\|[^>]*)?>$/;
const MENTION_CHANNEL = /^<#([CG][A-Z0-9]+)(?:\|[^>]*)?>$/;

/**
 * KPR-492 D4 redaction: what a resolver-failure log line may carry. The Slack
 * code when `raw` is a platform error (`…occurred: <code>`); otherwise a class
 * for the two hive-authored failures. NEVER the target, handle, email or any
 * candidate handle — those belong in the tool result, which is not a log.
 */
function resolutionFailureCode(raw: string): string {
  const m = /occurred: ([a-z_]+)/.exec(raw);
  if (m) return m[1];
  return raw.startsWith("ambiguous") ? "ambiguous" : "no_match";
}

/**
 * KPR-492 D3: one `log.error` per process the first time an identity-mode post
 * falls back to a plain post. Warn-once is the house idiom (`clampLaneAEffort`,
 * the orphan-prefix warns). Module-level, so tests reset it explicitly.
 */
let identityFallbackReported = false;

/** Test-only: reset the D3 once-per-process latch so ordering across describes cannot decide the assertion. */
export function __resetIdentityFallbackLatchForTests(): void {
  identityFallbackReported = false;
}

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
  private notificationWeb: WebClient;
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
  // ── KPR-492 D4: user + IM resolution caches ────────────────────────────
  // The spec names one `userIdByHandle` map; it becomes three here because a
  // Map<string,string> cannot express the ambiguity guard the same paragraph
  // requires (">1 distinct match errors and names the candidates"). Same
  // lifecycle as the single map: lazily built, all cleared in sweep().
  /** lowercased Slack `user.name` (workspace-unique) → user id */
  private userIdByName = new Map<string, string>();
  /** lowercased display_name / real_name → every matching user id */
  private userIdsByDisplayName = new Map<string, Set<string>>();
  /** user id → "@name", for naming candidates in the ambiguity error */
  private userHandleById = new Map<string, string>();
  /** user id → the bot↔user IM (D…) id returned by conversations.open */
  private imIdByUserId = new Map<string, string>();
  private userHandleMapBuilt = false;
  /**
   * The Slack error from the most recent `users.list` page-through, if it failed.
   * Read ONLY on the post-rebuild miss in `resolveUserId`, so a transport fault,
   * `ratelimited` or `missing_scope` reaches the agent as what it is rather than
   * as a false "no active Slack user matches" — exactly the false does-not-exist
   * the miss policy was added to avoid (plan-review round 3 advisory). An
   * instance field is correct HERE, unlike the post sink: the handle map is
   * shared state and this describes the shared build, not any one caller's send.
   */
  private lastUserListError: string | undefined;
  private outboundTsCache = new OutboundTsCache();
  private integrationChannels = new Set<string>(); // channel names that accept bot messages
  private botToken: string;
  /** Slack error from the most recent readChannel failure, so callers can surface the real cause. */
  lastReadError: string | undefined;

  constructor(appToken: string, botToken: string, notificationOptions: Pick<WebClientOptions, "fetch"> = {}) {
    this.socket = new SocketModeClient({ appToken });
    this.web = new WebClient(botToken);
    this.notificationWeb = new WebClient(botToken, {
      ...noticeClientOptions,
      fetch: validatedNoticeFetch(notificationOptions.fetch),
    });
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
        // Enrich file objects via files.info — Socket Mode events often carry
        // partial file metadata (missing url_private_download / url_private).
        // files.info returns the full object including the download URL.
        const enrichedFiles = await Promise.all(
          (event.files as any[]).map(async (f: any) => {
            if (f.url_private_download || f.url_private) return f;
            try {
              const info = await this.web.files.info({ file: f.id as string });
              return (info.file as any) ?? f;
            } catch (err) {
              log.warn("files.info failed, using partial file object", {
                id: f.id,
                name: f.name,
                error: String(err),
              });
              return f;
            }
          }),
        );
        const results = await Promise.all(
          enrichedFiles.map((f: any) => downloadAndProcess(f as SlackFile, this.botToken)),
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
    errorSink?: PostErrorSink,
  ): Promise<string | undefined> {
    if (text.length <= SlackGateway.SLACK_MAX_CHARS) {
      return this.postSingle(channel, text, threadTs, identity, errorSink);
    }

    if (text.length <= SlackGateway.SPLIT_MAX_CHARS) {
      return this.postSplit(channel, text, threadTs, identity, errorSink);
    }

    return this.postAsFile(channel, text, threadTs, identity, errorSink);
  }

  private async postSingle(
    channel: string,
    text: string,
    threadTs?: string,
    identity?: { name: string; icon?: string },
    errorSink?: PostErrorSink,
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
        // KPR-492 D2: record it even though the plain retry follows — the sink is
        // read only when nothing landed, so this surfaces only if the retry also
        // yields no ts without throwing its own error.
        if (errorSink) errorSink.error = String(err);
        // KPR-492 D3: the fallback stays (⚠A3 — a generically-labelled post beats
        // no post, and the floor is "not a human"), but it stops being quiet.
        log.warn("Failed to post with identity, falling back to plain post", {
          channel,
          username: identity.name,
          error: String(err),
        });
        if (!identityFallbackReported) {
          identityFallbackReported = true;
          log.error(
            "Slack identity-mode post failed — agent posts are rendering as the plain Hive bot. Grant chat:write.customize to the Slack app and reinstall; the boot scope preflight reports it.",
            { channel, username: identity.name, error: String(err) },
          );
        }
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
      if (errorSink) errorSink.error = String(err);
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
    errorSink?: PostErrorSink,
  ): Promise<string | undefined> {
    const chunks = this.splitText(text);
    log.info("Splitting oversized message", { channel, totalLength: text.length, chunks: chunks.length });

    let firstTs: string | undefined;
    for (let i = 0; i < chunks.length; i++) {
      const chunk = i === 0 ? chunks[i] : `_(cont.)_ ${chunks[i]}`;
      const ts = await this.postSingle(channel, chunk, threadTs, identity, errorSink);
      if (i === 0) firstTs = ts;
    }
    return firstTs;
  }

  private async postAsFile(
    channel: string,
    text: string,
    threadTs?: string,
    identity?: { name: string; icon?: string },
    errorSink?: PostErrorSink,
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
    const summaryTs = await this.postSingle(channel, summary, threadTs, identity, errorSink);

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
      return this.postSplit(channel, text, threadTs, identity, errorSink);
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
   *
   * Caller should resolve `channel` to a Slack conversation ID first (via
   * `resolveConversation`) — this method does not re-resolve, and does not return
   * a canonical channel ID.
   *
   * KPR-492 D1: `identity` is the same `{ name, icon }` Path A passes
   * (`slack-adapter.ts:196-197`). It used to be dropped here, so every Path B post
   * rendered as a generic "Hive" bot even on the bot transport.
   * KPR-492 D2: a fresh `PostErrorSink` per call carries the real Slack error out,
   * replacing the useless `"postMessage returned no ts"` whenever one is available.
   */
  async postAndRegister(
    channel: string,
    text: string,
    threadTs?: string,
    identity?: { name: string; icon?: string },
  ): Promise<{ ok: boolean; ts?: string; error?: string }> {
    const sink: PostErrorSink = {};
    try {
      const ts = await this.postMessage(channel, text, threadTs, identity, sink);
      if (ts) return { ok: true, ts };
      return { ok: false, error: sink.error ?? "postMessage returned no ts" };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  }

  notificationChannelMatches(homeBase: string, channelId: string): boolean {
    const input = homeBase.trim();
    return /^[CDG][A-Z0-9]+$/.test(input)
      ? input === channelId
      : this.channelIdCache.get(input.replace(/^#/, "")) === channelId;
  }

  async resolveNotificationChannel(homeBase: string, gate: NoticeLookupGate): Promise<NoticeDestination> {
    const input = homeBase.trim();
    if (!input) return { channelId: null };
    if (/^[CDG][A-Z0-9]+$/.test(input)) return { channelId: input };

    const name = input.replace(/^#/, "");
    const cached = this.channelIdCache.get(name);
    if (cached) return { channelId: cached };

    try {
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        if (!(await gate.check()) || !gate.current()) return { channelId: null };
        const response = await this.notificationWeb.conversations.list({
          limit: 1000,
          cursor,
          exclude_archived: true,
          types: "public_channel,private_channel",
        });
        if (response.ok !== true) {
          const outcome = classifyNoticeResponse(response, "");
          return {
            channelId: null,
            ...(outcome.kind === "acknowledged"
              ? {}
              : { retryAfterMs: outcome.retryAfterMs, retryBlocked: outcome.retryBlocked }),
          };
        }
        for (const channel of response.channels ?? []) {
          if (channel.id && channel.name) {
            this.channelIdCache.set(channel.name, channel.id);
            this.channelNameCache.set(channel.id, channel.name);
          }
        }
        const found = this.channelIdCache.get(name);
        if (found) return { channelId: found };
        cursor = response.response_metadata?.next_cursor || undefined;
        if (cursor && (seen.has(cursor) || seen.size >= 100)) return { channelId: null };
        if (cursor) seen.add(cursor);
      } while (cursor);
      return { channelId: this.channelIdCache.get(name) ?? null };
    } catch (error) {
      const outcome = classifyNoticeError(error, "");
      return {
        channelId: null,
        ...(outcome.kind === "acknowledged"
          ? {}
          : { retryAfterMs: outcome.retryAfterMs, retryBlocked: outcome.retryBlocked }),
      };
    }
  }

  async postNotificationReceipt(channelId: string, text: string): Promise<SendResult> {
    if (!/^[CDG][A-Z0-9]+$/.test(channelId) || !text.trim() || text.length > 3900) {
      return { kind: "not-accepted", reason: "invalid-state" };
    }
    try {
      const response = await this.notificationWeb.chat.postMessage({
        channel: channelId,
        text,
        mrkdwn: false,
        parse: "none",
        link_names: false,
        unfurl_links: false,
        unfurl_media: false,
      });
      const outcome = classifyNoticeResponse(response, channelId);
      if (outcome.kind === "acknowledged") {
        this.outboundTsCache.register(outcome.channelId, outcome.messageTs);
      }
      return outcome;
    } catch (error) {
      return classifyNoticeError(error, channelId);
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

  /**
   * KPR-492 D4: resolve a send/read target to a Slack conversation id.
   *
   * Rung 0 unwraps Slack mention syntax (`<@U…>`, `<@U…|label>`, `<#C…|name>`,
   * `<#C…>`) to the bare id it encodes — two regexes, zero API calls — and the
   * result is then treated exactly as if the agent had typed it. It widens the
   * accepted ENCODINGS, not the resolution paths: an unwrapped `<@U…>` still
   * shape-rejects under `allowUserForms: false`. Only the mention match sees a
   * trimmed string; a non-matching target proceeds UNTRIMMED, so rung 6 stays
   * byte-equivalent to today's `resolveChannelId` behaviour (§5.3).
   *
   * Then six rungs, first match wins:
   *   1. `C…`/`G…` channel id       → verbatim
   *   2. `D…` IM id                 → verbatim (may be a DM the bot is not in — D2 explains the failure)
   *   3. `U…`/`W…` user id          → conversations.open        (`im:write`)
   *   4. email                      → users.lookupByEmail → open (`users:read.email`)
   *   5. leading `@`                → resolveUserId → open       (`users:read`, `im:write`)
   *   6. otherwise                  → today's channel-name path, `resolveChannelId` unchanged
   *
   * `allowUserForms` is REQUIRED, not an option with a default: it code-enforces
   * §5.3's read/send asymmetry at every call site instead of leaving it to a
   * default a future caller inherits by omission. `handleSend` passes `true`,
   * `handleRead` passes `false`.
   *
   * Under `false` the user forms are shape-matched and rejected with ZERO API
   * calls — NOT fallen through to rung 6, which could neither produce the
   * person-flavoured error nor avoid paging the whole workspace on every
   * mistargeted read. The tests assert all three call counts, because the return
   * value alone cannot distinguish the two implementations.
   *
   * Rungs 1-3 use the tighter `/^[CDG][A-Z0-9]+$/`-family regexes (in-repo
   * precedent: `:653`, `:661`, `:712`) rather than `startsWith("C")`, so a bare
   * name that merely begins with an uppercase letter is not matched AS AN ID HERE.
   * It is NOT a workspace-wide fix: rung 6 delegates to `resolveChannelId`, which
   * keeps its own `startsWith("C"|"D"|"G")` passthrough (`:742-744`) and still
   * returns e.g. `"D-team"` verbatim. That residual is deliberate — this ticket
   * preserves rung 6's behaviour byte-for-byte (§5.3 asks for today's input set
   * "modulo the tighter id regex" on rungs 1-3 only), and `slack-gateway.test.ts`'s
   * `resolveChannelId` describe still pins the loose check as-is.
   * Bare names stay channel-first — `@` is the disambiguator.
   *
   * Log redaction (D4, round 5): the single warn below carries `form` + `code`
   * and never the target. `users:read.email` makes every colleague's address
   * reachable to this process; the logs must not become where it lands.
   */
  async resolveConversation(target: string, allowUserForms: boolean): Promise<ResolvedConversation> {
    if (!target) return { ok: false, error: "channel is required" };

    // rung 0 — unwrap mention syntax; a non-match leaves `target` untouched.
    const trimmed = target.trim();
    const mention = MENTION_USER.exec(trimmed) ?? MENTION_CHANNEL.exec(trimmed);
    if (mention) target = mention[1];

    if (/^[CG][A-Z0-9]+$/.test(target)) return { ok: true, id: target }; // rung 1
    if (/^D[A-Z0-9]+$/.test(target)) return { ok: true, id: target }; // rung 2

    const isUserId = /^[UW][A-Z0-9]+$/.test(target); // rung 3
    const isEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target); // rung 4
    const isHandle = target.startsWith("@"); // rung 5
    if (isUserId || isEmail || isHandle) {
      if (!allowUserForms) {
        return {
          ok: false,
          error: `"${target}" is a person, not a channel — this tool reads channels only (DM history is not available on the bot transport)`,
        };
      }
      const form = isUserId ? "id" : isEmail ? "email" : "handle";
      let result: ResolvedConversation;
      if (isUserId) {
        result = await this.openIm(target);
      } else if (isEmail) {
        const looked = await this.lookupUserByEmail(target);
        result = looked.ok ? await this.openIm(looked.id) : looked;
      } else {
        const resolved = await this.resolveUserId(target.slice(1));
        result = resolved.ok ? await this.openIm(resolved.id) : resolved;
      }
      if (!result.ok) {
        // The ONE resolver-failure log line. Form class + code only (D4 redaction).
        log.warn("slack target resolution failed", { form, code: resolutionFailureCode(result.error) });
      }
      return result;
    }

    // rung 6 — today's channel-name path verbatim (# strip, channelIdCache,
    // paged conversations.list). `resolveChannelId` survives as this rung's
    // implementation; it has no other production caller once the internal API
    // moves, and `slack-gateway.test.ts`'s resolveChannelId describe keeps
    // pinning rung 6 directly. Do not delete either as dead weight.
    const id = await this.resolveChannelId(target);
    return id ? { ok: true, id } : { ok: false, error: `unknown channel: ${target}` };
  }

  /**
   * KPR-492 D4: resolve a handle or a user id to a user id. NOT an email — email
   * is rung 4 and is served by `users.lookupByEmail` inside `resolveConversation`.
   *
   * `U…`/`W…` returns verbatim with NO `users.list` page-through and no map
   * consultation. That passthrough is load-bearing for `handleUsers`:
   * `slack_read_user_profile` advertises "user ID (U…) or display name" and
   * passes its raw input to `users.info` today, so a map-only implementation
   * would regress every id lookup into a re-page plus a false "no active Slack
   * user matches".
   */
  async resolveUserId(handle: string): Promise<ResolvedUser> {
    if (/^[UW][A-Z0-9]+$/.test(handle)) return { ok: true, id: handle };

    // Strip a leading `@` HERE, not only at rung 5 (spec D4, round 6): `handleUsers`
    // passes slack_read_user_profile's raw input straight in, so without this an
    // `@alice` would miss the map, burn the one rebuild, and 400 as a false "no such
    // user". Rung 5's own `slice(1)` becomes redundant and harmless.
    const key = handle.replace(/^@/, "").trim().toLowerCase();
    if (!key) return { ok: false, error: `no active Slack user matches "${handle}"` };

    if (!this.userHandleMapBuilt) await this.buildUserHandleMap();
    let hit = this.matchHandle(key);
    if (hit.kind === "miss") {
      // Miss policy: ONE rebuild, then error. A user who joined (or changed their
      // display name) after the map was built is otherwise unresolvable until the
      // next sweep(), and the agent sees "no such person" for someone who plainly
      // exists. Per-miss, not per-call, and not itself retried.
      await this.buildUserHandleMap(true);
      hit = this.matchHandle(key);
    }
    if (hit.kind === "exact") return { ok: true, id: hit.id };
    if (hit.kind === "ambiguous") {
      return {
        ok: false,
        error: `ambiguous — ${hit.labels.length} users match "${handle}": ${hit.labels.join(", ")} (use their @handle, user id, or email)`,
      };
    }
    if (this.lastUserListError) {
      // The map is empty (or stale) because users.list FAILED, not because the
      // person is absent. Say so, carrying Slack's code so describeSendFailure
      // maps missing_scope / ratelimited on the send path. A false "does not
      // exist" is the one answer this method must never give.
      return {
        ok: false,
        error: `could not list Slack users to resolve "${handle}" (slack error: ${this.lastUserListError})`,
      };
    }
    return { ok: false, error: `no active Slack user matches "${handle}" — try their @handle, user id, or email` };
  }

  /** KPR-492 D4: open (or reuse) the bot↔user IM. `conversations.open` is a WRITE — send path only (§5.3). */
  private async openIm(userId: string): Promise<ResolvedConversation> {
    const cached = this.imIdByUserId.get(userId);
    if (cached) return { ok: true, id: cached };
    try {
      const res = await this.web.conversations.open({ users: userId });
      const id = (res.channel as { id?: string } | undefined)?.id;
      if (!id) return { ok: false, error: `conversations.open returned no channel for ${userId}` };
      this.imIdByUserId.set(userId, id);
      return { ok: true, id };
    } catch (err) {
      // Carries Slack's code (cannot_dm_bot, missing_scope, …) — handleSend maps it.
      return { ok: false, error: (err as Error).message };
    }
  }

  private async lookupUserByEmail(email: string): Promise<ResolvedUser> {
    try {
      const res = await this.web.users.lookupByEmail({ email });
      const id = res.user?.id;
      if (!id) return { ok: false, error: `no active Slack user matches ${email}` };
      return { ok: true, id };
    } catch (err) {
      // Carries user_not_found / users_not_found / missing_scope — handleSend maps it.
      return { ok: false, error: (err as Error).message };
    }
  }

  /**
   * Page `users.list` once and index it three ways. Skips `deleted` and `is_bot`.
   * Stores NO emails (D4: the `users:read.email` grant must not be amplified into
   * an in-memory directory). On failure the flag is still set, so a broken token
   * cannot hot-loop the API — a later miss still gets its one forced rebuild, and
   * `sweep()` clears the flag — but the failure is REMEMBERED in
   * `lastUserListError` so the post-rebuild miss reports it instead of "no such
   * user". Cost: one paged page-through per process (or per sweep, plus one per
   * miss) — the same class as the existing `conversations.list` channel-name cache.
   */
  private async buildUserHandleMap(force = false): Promise<void> {
    if (this.userHandleMapBuilt && !force) return;
    this.userIdByName.clear();
    this.userIdsByDisplayName.clear();
    this.userHandleById.clear();
    this.lastUserListError = undefined;
    try {
      let cursor: string | undefined;
      do {
        const res = await this.web.users.list({ limit: 200, cursor });
        for (const m of res.members ?? []) {
          if (!m.id || m.deleted || m.is_bot) continue;
          if (m.name) {
            this.userIdByName.set(m.name.toLowerCase(), m.id);
            this.userHandleById.set(m.id, `@${m.name}`);
          }
          for (const alt of [m.profile?.display_name, m.profile?.real_name, m.real_name]) {
            if (!alt) continue;
            const k = alt.toLowerCase();
            const set = this.userIdsByDisplayName.get(k) ?? new Set<string>();
            set.add(m.id);
            this.userIdsByDisplayName.set(k, set);
          }
        }
        cursor = res.response_metadata?.next_cursor || undefined;
      } while (cursor);
    } catch (err) {
      // No target in this line either — it is a build failure, not a lookup.
      this.lastUserListError = String(err);
      log.warn("users.list page-through failed", { error: String(err) });
    }
    this.userHandleMapBuilt = true;
  }

  /** Exact `user.name` wins outright; otherwise display/real-name matches, with an ambiguity guard. Never guesses. */
  private matchHandle(
    key: string,
  ): { kind: "exact"; id: string } | { kind: "ambiguous"; labels: string[] } | { kind: "miss" } {
    const exact = this.userIdByName.get(key);
    if (exact) return { kind: "exact", id: exact };
    const ids = [...(this.userIdsByDisplayName.get(key) ?? [])];
    if (ids.length === 1) return { kind: "exact", id: ids[0] };
    if (ids.length > 1) return { kind: "ambiguous", labels: ids.map((id) => this.userHandleById.get(id) ?? id) };
    return { kind: "miss" };
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
   * Returns messages enriched with file content (hive_files field), or undefined on error.
   * Messages that contain Slack files/snippets will have a `hive_files` array added,
   * each entry containing the extracted text content so agents can read file contents.
   */
  async readChannel(channel: string, limit = 50): Promise<Array<Record<string, unknown>> | undefined> {
    try {
      this.lastReadError = undefined;
      const res = await this.web.conversations.history({ channel, limit });
      const messages = (res.messages ?? []) as Array<Record<string, unknown>>;

      // Enrich messages that have files with extracted content
      const enriched = await Promise.all(
        messages.map(async (msg) => {
          const files = msg.files as SlackFile[] | undefined;
          if (!files?.length) return msg;

          // Enrich via files.info — conversations.history often returns partial file objects
          // (missing url_private_download / url_private), just like Socket Mode events.
          const enrichedFiles = await Promise.all(
            files.map(async (f) => {
              if (f.url_private_download || f.url_private) return f;
              try {
                const info = await this.web.files.info({ file: f.id });
                return (info.file as SlackFile) ?? f;
              } catch (err) {
                log.warn("files.info failed during readChannel, using partial file object", {
                  id: f.id,
                  name: f.name,
                  error: String(err),
                });
                return f;
              }
            }),
          );

          const processed = await Promise.all(enrichedFiles.map((f) => downloadAndProcess(f, this.botToken)));

          const hiveFiles = processed
            .filter((f): f is ProcessedFile => f !== null)
            .map(({ name, mimetype, size, textContent, isImage }) => ({
              name,
              mimetype,
              size,
              textContent,
              isImage,
            }));

          return hiveFiles.length > 0 ? { ...msg, hive_files: hiveFiles } : msg;
        }),
      );

      return enriched;
    } catch (err) {
      this.lastReadError = (err as Error).message;
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
    const pruned =
      this.channelNameCache.size +
      this.channelIdCache.size +
      this.userNameCache.size +
      // KPR-492 D4 — all FOUR new maps. `pruned` is sweep()'s only observable
      // output, so a map that is cleared but not counted under-reports silently.
      this.userIdByName.size +
      this.userIdsByDisplayName.size +
      this.userHandleById.size +
      this.imIdByUserId.size;
    this.channelNameCache.clear();
    this.channelIdCache.clear();
    this.userNameCache.clear();
    this.userIdByName.clear();
    this.userIdsByDisplayName.clear();
    this.userHandleById.clear();
    this.imIdByUserId.clear();
    this.userHandleMapBuilt = false;
    this.lastUserListError = undefined;
    return { component: "slack-gateway", pruned, retried: 0, bytesFreed: 0, errors: [] };
  }

  get client(): WebClient {
    return this.web;
  }
}
