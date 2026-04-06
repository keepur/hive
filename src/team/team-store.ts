// src/team/team-store.ts

import { MongoClient, type Db, type Collection, ObjectId } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { TeamChannel, TeamMessage } from "./types.js";
import { dmChannelId } from "./types.js";

const log = createLogger("team-store");

export class TeamStore {
  private client: MongoClient;
  private db!: Db;
  private channels!: Collection<TeamChannel>;
  private messages!: Collection<TeamMessage>;

  constructor(
    private uri: string,
    private dbName: string,
  ) {
    this.client = new MongoClient(uri);
  }

  async connect(): Promise<void> {
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.channels = this.db.collection<TeamChannel>("team_channels");
    this.messages = this.db.collection<TeamMessage>("team_messages");

    // Indexes
    await this.channels.createIndex({ type: 1 });
    await this.channels.createIndex({ members: 1 });
    await this.messages.createIndex({ channelId: 1, createdAt: -1 });
    await this.messages.createIndex({ threadId: 1 });
    await this.messages.createIndex({ createdAt: -1 });

    log.info("Team store connected", { db: this.dbName });
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // ── Channels ──────────────────────────────────────────────────

  async getChannel(id: string): Promise<TeamChannel | null> {
    return this.channels.findOne({ _id: id, archived: { $ne: true } });
  }

  async listChannels(memberId?: string): Promise<TeamChannel[]> {
    const filter: Record<string, unknown> = { archived: { $ne: true } };
    if (memberId) filter.members = memberId;
    return this.channels.find(filter).sort({ updatedAt: -1 }).toArray();
  }

  async createChannel(channel: TeamChannel): Promise<TeamChannel> {
    await this.channels.insertOne(channel);
    log.info("Channel created", { id: channel._id, type: channel.type });
    return channel;
  }

  async getOrCreateDm(participantA: string, participantB: string, creatorName?: string): Promise<TeamChannel> {
    const id = dmChannelId(participantA, participantB);
    const existing = await this.channels.findOne({ _id: id });
    if (existing) return existing;

    const dm: TeamChannel = {
      _id: id,
      type: "dm",
      name: creatorName ? `DM with ${creatorName}` : `DM: ${participantA} & ${participantB}`,
      members: [participantA, participantB].sort(),
      createdBy: participantA,
      createdAt: new Date(),
      updatedAt: new Date(),
      archived: false,
    };
    await this.channels.insertOne(dm);
    log.info("DM created", { id, members: dm.members });
    return dm;
  }

  async joinChannel(channelId: string, memberId: string): Promise<boolean> {
    const result = await this.channels.updateOne(
      { _id: channelId, archived: { $ne: true } },
      { $addToSet: { members: memberId }, $set: { updatedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  async leaveChannel(channelId: string, memberId: string): Promise<boolean> {
    const result = await this.channels.updateOne(
      { _id: channelId },
      // `as any` needed: MongoDB driver types don't infer $pull on string arrays correctly
      { $pull: { members: memberId } as any, $set: { updatedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  async archiveChannel(channelId: string): Promise<boolean> {
    const result = await this.channels.updateOne(
      { _id: channelId },
      { $set: { archived: true, updatedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  async renameChannel(channelId: string, name: string): Promise<boolean> {
    const result = await this.channels.updateOne({ _id: channelId }, { $set: { name, updatedAt: new Date() } });
    return result.modifiedCount > 0;
  }

  // ── Messages ──────────────────────────────────────────────────

  async saveMessage(msg: Omit<TeamMessage, "_id">): Promise<TeamMessage> {
    const doc = { ...msg, _id: new ObjectId().toHexString() };
    await this.messages.insertOne(doc as any);

    // Touch channel updatedAt
    await this.channels.updateOne({ _id: msg.channelId }, { $set: { updatedAt: new Date() } });

    return doc;
  }

  async getHistory(
    channelId: string,
    options?: { before?: string; limit?: number; threadId?: string },
  ): Promise<{ messages: TeamMessage[]; hasMore: boolean }> {
    const limit = Math.min(options?.limit ?? 50, 100);
    const filter: Record<string, unknown> = { channelId };

    if (options?.before) {
      filter._id = { $lt: options.before };
    }
    if (options?.threadId) {
      filter.threadId = options.threadId;
    }

    const messages = await this.messages
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(limit + 1)
      .toArray();

    const hasMore = messages.length > limit;
    if (hasMore) messages.pop();

    return { messages: messages.reverse(), hasMore };
  }
}
