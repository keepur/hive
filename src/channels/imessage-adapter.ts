import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { MongoClient, type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import type { WorkItem, WorkResult, ChannelKind } from "../types/work-item.js";
import type { SlackGateway } from "../slack/slack-gateway.js";
import { IMessageDb, type ParsedMessage } from "./imessage-db.js";

const log = createLogger("imessage-adapter");

interface IMessageConfig {
  enabled: boolean;
  slackChannel: string;
  hotWindowMs: number;
  coldIntervalMs: number;
  hotIntervalMs: number;
}

interface SlackThreadMapping {
  handleId: string;
  slackThreadTs: string;
  displayName: string;
  createdAt: Date;
}

interface Contact {
  phones?: string[];
  emails?: string[];
  name?: string;
  displayName?: string;
}

export class IMessageAdapter implements ChannelAdapter {
  readonly id = "imessage";
  readonly kind: ChannelKind = "imessage";

  private config: IMessageConfig;
  private mongoUri: string;
  private dbName: string;
  private gateway: SlackGateway;

  private db?: IMessageDb;
  private mongo?: MongoClient;
  private threadsCollection?: Collection<SlackThreadMapping>;
  private contactsCollection?: Collection<Contact>;
  private slackChannelId?: string;

  private interval: ReturnType<typeof setInterval> | null = null;
  private lastSeenRowId = 0;
  private lastMessageAt = 0; // wall-clock timestamp of last received message
  private lastColdPoll = 0;
  private stateFilePath: string;

  constructor(config: IMessageConfig, mongoUri: string, dbName: string, gateway: SlackGateway, instanceId: string) {
    this.config = config;
    this.mongoUri = mongoUri;
    this.dbName = dbName;
    this.gateway = gateway;
    this.stateFilePath = resolve(`/tmp/${instanceId}-imessage-state.json`);
  }

  async start(onWorkItem: (item: WorkItem) => void): Promise<void> {
    // Connect to MongoDB for thread mappings
    this.mongo = new MongoClient(this.mongoUri);
    await this.mongo.connect();
    const db = this.mongo.db(this.dbName);
    this.threadsCollection = db.collection<SlackThreadMapping>("imessage_threads");
    this.contactsCollection = db.collection<Contact>("contacts");

    // Resolve Slack channel ID
    try {
      const channels = await this.gateway.client.conversations.list({
        types: "public_channel",
        limit: 200,
      });
      const ch = (channels.channels ?? []).find((c: any) => c.name === this.config.slackChannel);
      if (ch?.id) {
        this.slackChannelId = ch.id;
        log.info("Slack mirror channel resolved", { channel: this.config.slackChannel, id: ch.id });
      } else {
        log.warn("Slack mirror channel not found", { channel: this.config.slackChannel });
      }
    } catch (err) {
      log.warn("Failed to resolve Slack mirror channel", { error: String(err) });
    }

    // Open chat.db
    try {
      this.db = new IMessageDb();
    } catch (err) {
      log.error("Failed to open chat.db — check Full Disk Access for node", { error: String(err) });
      return;
    }

    // Restore or initialize lastSeenRowId
    this.loadState();
    if (this.lastSeenRowId === 0) {
      // First run — skip all existing messages
      this.lastSeenRowId = this.db.getMaxRowId();
      this.saveState();
      log.info("First run — initialized lastSeenRowId", { lastSeenRowId: this.lastSeenRowId });
    }

    // Start polling at the hot interval — adaptive logic inside poll() skips when cold
    this.interval = setInterval(() => this.poll(onWorkItem), this.config.hotIntervalMs);
    // Poll immediately
    this.poll(onWorkItem);

    log.info("iMessage adapter started", {
      lastSeenRowId: this.lastSeenRowId,
      hotIntervalMs: this.config.hotIntervalMs,
      coldIntervalMs: this.config.coldIntervalMs,
    });
  }

  async deliver(result: WorkResult): Promise<void> {
    if (result.error) {
      log.warn("Skipping iMessage delivery due to error", { error: result.error });
      return;
    }

    const recipient = result.workItem.sender;

    try {
      this.sendViaAppleScript(recipient, result.text);
      log.info("iMessage reply sent", { to: recipient });
    } catch (err) {
      // One retry
      log.warn("iMessage send failed, retrying", { error: String(err), to: recipient });
      try {
        await delay(500);
        this.sendViaAppleScript(recipient, result.text);
        log.info("iMessage reply sent on retry", { to: recipient });
      } catch (retryErr) {
        log.error("iMessage delivery failed after retry", { error: String(retryErr), to: recipient });
        return;
      }
    }

    // Mirror agent response to Slack thread
    await this.mirrorToSlack(recipient, result.text, result.agentId, true);
  }

  async stop(): Promise<void> {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    this.db?.close();
    await this.mongo?.close();
    log.info("iMessage adapter stopped");
  }

  // --- Private helpers ---

  private async poll(onWorkItem: (item: WorkItem) => void): Promise<void> {
    // Adaptive polling: skip this tick if we're in cold mode and haven't reached the cold interval
    const now = Date.now();
    const isHot = now - this.lastMessageAt < this.config.hotWindowMs;
    if (!isHot && now - this.lastColdPoll < this.config.coldIntervalMs) {
      return; // Skip — still in cold window
    }
    if (!isHot) {
      this.lastColdPoll = now;
    }

    if (!this.db) return;

    try {
      const messages = this.db.getNewMessages(this.lastSeenRowId);
      if (messages.length === 0) return;

      for (const msg of messages) {
        this.lastSeenRowId = msg.rowId;
        this.lastMessageAt = now;

        const workItem: WorkItem = {
          id: `imsg-${msg.rowId}`,
          text: msg.text,
          source: {
            kind: "imessage",
            id: "imessage",
            label: "imessage",
          },
          sender: msg.sender,
          threadId: `imessage:${msg.sender}`,
          timestamp: msg.date,
          meta: {
            messageRowId: msg.rowId,
            service: msg.service,
          },
        };

        log.info("iMessage received", {
          from: msg.sender,
          service: msg.service,
          textLength: msg.text.length,
        });

        // Mirror inbound message to Slack
        await this.mirrorToSlack(msg.sender, msg.text, undefined, false);

        onWorkItem(workItem);
      }

      this.saveState();
    } catch (err) {
      log.error("iMessage poll failed", { error: String(err) });
    }
  }

  private sendViaAppleScript(recipient: string, text: string): void {
    // Escape for AppleScript string literal
    const escaped = text.replace(/\\/g, "\\\\").replace(/"/g, '\\"');

    execFileSync("osascript", [
      "-e",
      'tell application "Messages"',
      "-e",
      "set targetService to 1st account whose service type = iMessage",
      "-e",
      `set targetBuddy to participant "${recipient}" of targetService`,
      "-e",
      `send "${escaped}" to targetBuddy`,
      "-e",
      "end tell",
    ]);
  }

  private async mirrorToSlack(
    handleId: string,
    text: string,
    agentId: string | undefined,
    isOutbound: boolean,
  ): Promise<void> {
    if (!this.slackChannelId || !this.threadsCollection) return;

    try {
      // Look up existing Slack thread for this contact
      const existing = await this.threadsCollection.findOne({ handleId });
      let slackThreadTs: string;

      if (existing) {
        slackThreadTs = existing.slackThreadTs;
      } else {
        // Create new thread — post parent message
        const displayName = await this.resolveContactName(handleId);
        const parentText = `:speech_balloon: iMessage conversation with ${displayName}`;
        const parentTs = await this.gateway.postMessage(this.slackChannelId, parentText);

        if (!parentTs) {
          log.warn("Failed to create Slack mirror thread", { handleId });
          return;
        }

        slackThreadTs = parentTs;
        await this.threadsCollection.insertOne({
          handleId,
          slackThreadTs,
          displayName,
          createdAt: new Date(),
        });
      }

      // Post message as thread reply
      const prefix = isOutbound ? (agentId ? `*${agentId}*: ` : "*Agent*: ") : `*${handleId}*: `;
      await this.gateway.postMessage(this.slackChannelId, `${prefix}${text}`, slackThreadTs);
    } catch (err) {
      log.warn("Slack mirror failed", { error: String(err), handleId });
    }
  }

  private async resolveContactName(handleId: string): Promise<string> {
    if (!this.contactsCollection) return handleId;

    try {
      // Try matching by phone or email
      const contact = await this.contactsCollection.findOne({
        $or: [{ phones: handleId }, { emails: handleId }],
      });
      if (contact?.displayName) return `${contact.displayName} (${handleId})`;
      if (contact?.name) return `${contact.name} (${handleId})`;
    } catch {
      // Fall through to raw identifier
    }

    return handleId;
  }

  private loadState(): void {
    try {
      if (existsSync(this.stateFilePath)) {
        const data = JSON.parse(readFileSync(this.stateFilePath, "utf-8"));
        this.lastSeenRowId = data.lastSeenRowId ?? 0;
        log.info("Restored iMessage state", { lastSeenRowId: this.lastSeenRowId });
      }
    } catch (err) {
      log.warn("Failed to load iMessage state, starting fresh", { error: String(err) });
    }
  }

  private saveState(): void {
    try {
      const dir = resolve(this.stateFilePath, "..");
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
      writeFileSync(this.stateFilePath, JSON.stringify({ lastSeenRowId: this.lastSeenRowId }));
    } catch (err) {
      log.warn("Failed to save iMessage state", { error: String(err) });
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
