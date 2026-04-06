# Team Layer Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Build a native Team messaging layer inside Hive — channels, DMs, slash commands, @mentions, and agent-to-agent direct comms — replacing Slack as the primary interface for native clients.

**Architecture:** A new `src/team/` subsystem manages channels, DMs, message persistence, and a slash command registry. The existing WS adapter is extended (not replaced) to understand Team protocol messages. The dispatcher gains a `resolveFromTeam()` path for Team-originated messages. A new `team-mcp-server` gives agents the `send_message` tool for direct inter-agent communication.

**Tech Stack:** TypeScript, MongoDB, WebSocket (ws), MCP SDK (@modelcontextprotocol/sdk), Zod

**Spec:** `docs/specs/2026-04-06-team-layer-design.md`
**Ticket:** #99

---

## File Map

| File | Responsibility |
|------|---------------|
| `src/team/types.ts` | TeamChannel, TeamMessage, TeamCommand, TeamMember types |
| `src/team/team-store.ts` | MongoDB CRUD for channels, messages, commands |
| `src/team/command-registry.ts` | In-memory command registry, core commands, plugin hook |
| `src/team/team-mcp-server.ts` | `send_message` + `list_agents` MCP tools for agents |
| `src/channels/ws/protocol.ts` | Extended with Team message types |
| `src/channels/ws/ws-adapter.ts` | Team-aware message handling, command interception, file support |
| `src/channels/dispatcher.ts` | `resolveFromTeam()` routing path |
| `src/types/work-item.ts` | Add `"team"` to ChannelKind |
| `src/agents/agent-runner.ts` | Register team MCP server |
| `src/plugins/types.ts` | `registerCommands()` hook on PluginManifest |
| `src/plugins/plugin-loader.ts` | Call `registerCommands()` during plugin load |
| `src/config.ts` | Team config section |
| `src/index.ts` | Team store initialization at startup |

---

### Task 1: Types and Data Model

**Files:**
- Create: `src/team/types.ts`

- [ ] **Step 1:** Create the Team types file with all core types

```typescript
// src/team/types.ts

export interface TeamChannel {
  _id: string; // "general", "production", "dm:<sortedA>:<sortedB>"
  type: "channel" | "dm";
  name: string;
  members: string[]; // agent IDs + device IDs
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
  archived: boolean;
}

export interface TeamMessageFile {
  name: string;
  mimetype: string;
  size: number;
  storageKey: string;
  isImage: boolean;
}

export interface TeamMessage {
  _id?: string; // ObjectId string
  channelId: string;
  threadId?: string;
  senderId: string;
  senderType: "agent" | "person";
  senderName: string;
  text: string;
  files?: TeamMessageFile[];
  command?: { name: string; args: string[]; result?: string };
  createdAt: Date;
  editedAt?: Date;
}

export interface TeamCommandDef {
  name: string;
  source: "core" | "skill";
  pluginId?: string;
  description: string;
  args?: { name: string; required: boolean; description: string }[];
}

export interface TeamCommandHandler {
  def: TeamCommandDef;
  execute: (context: CommandContext) => Promise<string>;
}

export interface CommandContext {
  channelId: string;
  senderId: string;
  senderName: string;
  args: string[];
}

/** Helper: canonical DM channel ID from two participant IDs */
export function dmChannelId(a: string, b: string): string {
  const sorted = [a, b].sort();
  return `dm:${sorted[0]}:${sorted[1]}`;
}

/** Helper: canonical internal channel ID for agent-to-agent */
export function internalChannelId(a: string, b: string): string {
  const sorted = [a, b].sort();
  return `internal:${sorted[0]}:${sorted[1]}`;
}
```

- [ ] **Step 2:** Add `"team"` to ChannelKind

In `src/types/work-item.ts`, extend the union:

```typescript
export type ChannelKind = "slack" | "sms" | "imessage" | "email" | "scheduler" | "callback" | "internal" | "app" | "team";
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 4:** Commit

```bash
git add src/team/types.ts src/types/work-item.ts
git commit -m "feat(team): add Team layer types and data model (#99)"
```

---

### Task 2: Team Store (MongoDB CRUD)

**Files:**
- Create: `src/team/team-store.ts`

- [ ] **Step 1:** Create the Team store with channel and message CRUD

```typescript
// src/team/team-store.ts

import { MongoClient, type Db, type Collection, ObjectId } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { TeamChannel, TeamMessage, TeamMessageFile } from "./types.js";
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

  async getOrCreateDm(participantA: string, participantB: string, creatorName: string): Promise<TeamChannel> {
    const id = dmChannelId(participantA, participantB);
    const existing = await this.channels.findOne({ _id: id });
    if (existing) return existing;

    const dm: TeamChannel = {
      _id: id,
      type: "dm",
      name: `DM`,
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
    const result = await this.channels.updateOne(
      { _id: channelId },
      { $set: { name, updatedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  }

  // ── Messages ──────────────────────────────────────────────────

  async saveMessage(msg: Omit<TeamMessage, "_id">): Promise<TeamMessage> {
    const doc = { ...msg, _id: new ObjectId().toHexString() };
    await this.messages.insertOne(doc as any);

    // Touch channel updatedAt
    await this.channels.updateOne(
      { _id: msg.channelId },
      { $set: { updatedAt: new Date() } },
    );

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
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 3:** Commit

```bash
git add src/team/team-store.ts
git commit -m "feat(team): add TeamStore with channel and message CRUD (#99)"
```

---

### Task 3: WS Protocol Extensions

**Files:**
- Modify: `src/channels/ws/protocol.ts`

- [ ] **Step 1:** Add Team-aware client message types

Add after the existing `ClientPing` type and before the `ClientMessage` union:

```typescript
export interface ClientTeamMessage {
  type: "message";
  channelId: string;
  text: string;
  threadId?: string;
  id: string;
}

export interface ClientTeamImage {
  type: "image";
  channelId: string;
  data: string; // base64
  filename: string;
  id: string;
}

export interface ClientTeamFile {
  type: "file";
  channelId: string;
  data: string; // base64
  filename: string;
  mimetype: string;
  id: string;
}

export interface ClientJoin {
  type: "join";
  channelId: string;
  id: string;
}

export interface ClientLeave {
  type: "leave";
  channelId: string;
  id: string;
}

export interface ClientCommand {
  type: "command";
  channelId: string;
  name: string;
  args: string[];
  id: string;
}

export interface ClientCommandList {
  type: "command_list";
  id: string;
}

export interface ClientChannelList {
  type: "channel_list";
  id: string;
}

export interface ClientHistory {
  type: "history";
  channelId: string;
  before?: string;
  limit?: number;
  id: string;
}
```

Update the `ClientMessage` union:

```typescript
export type ClientMessage =
  | ClientTextMessage
  | ClientImageMessage
  | ClientPing
  | ClientTeamMessage
  | ClientTeamImage
  | ClientTeamFile
  | ClientJoin
  | ClientLeave
  | ClientCommand
  | ClientCommandList
  | ClientChannelList
  | ClientHistory;
```

- [ ] **Step 2:** Extend existing `ServerTextMessage` and add Team-aware server message types

First, add optional `channelId` to the existing `ServerTextMessage`:

```typescript
export interface ServerTextMessage {
  type: "message";
  text: string;
  agentId: string;
  agentName: string;
  replyTo?: string;
  channelId?: string; // present for Team messages, absent for legacy app messages
}
```

Then add new server types after existing `ServerError`:

```typescript
export interface ServerChannelList {
  type: "channel_list";
  channels: { id: string; type: string; name: string; members: string[] }[];
  id: string;
}

export interface ServerCommandList {
  type: "command_list";
  commands: { name: string; description: string; args?: { name: string; required: boolean; description: string }[] }[];
  id: string;
}

export interface ServerHistory {
  type: "history";
  channelId: string;
  messages: {
    id: string;
    senderId: string;
    senderType: string;
    senderName: string;
    text: string;
    threadId?: string;
    createdAt: string;
  }[];
  hasMore: boolean;
  id: string;
}

export interface ServerChannelEvent {
  type: "channel_event";
  channelId: string;
  event: "created" | "joined" | "left" | "archived";
  detail: Record<string, unknown>;
  id: string;
}
```

Update the `ServerMessage` union:

```typescript
export type ServerMessage =
  | ServerTextMessage
  | ServerAck
  | ServerTyping
  | ServerError
  | ServerChannelList
  | ServerCommandList
  | ServerHistory
  | ServerChannelEvent;
```

- [ ] **Step 3:** Extend `parseClientMessage()` to handle new types

Replace the existing `parseClientMessage` function body. The key change is: if a `message` or `image` has a `channelId`, it's a Team message (same `type` field, additional field distinguishes them):

```typescript
export function parseClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const msg = parsed as Record<string, unknown>;

  switch (msg.type) {
    case "message":
      if (typeof msg.text !== "string" || typeof msg.id !== "string") return null;
      if (typeof msg.channelId === "string") {
        // Team message — has channelId
        return {
          type: "message",
          channelId: msg.channelId,
          text: msg.text,
          threadId: typeof msg.threadId === "string" ? msg.threadId : undefined,
          id: msg.id,
        } as ClientTeamMessage;
      }
      // Legacy app message — no channelId
      return { type: "message", text: msg.text, id: msg.id };

    case "image":
      if (typeof msg.data !== "string" || typeof msg.filename !== "string" || typeof msg.id !== "string") return null;
      if (typeof msg.channelId === "string") {
        return {
          type: "image",
          channelId: msg.channelId,
          data: msg.data,
          filename: msg.filename,
          id: msg.id,
        } as ClientTeamImage;
      }
      return { type: "image", data: msg.data, filename: msg.filename, id: msg.id };

    case "file":
      if (
        typeof msg.channelId === "string" &&
        typeof msg.data === "string" &&
        typeof msg.filename === "string" &&
        typeof msg.mimetype === "string" &&
        typeof msg.id === "string"
      ) {
        return { type: "file", channelId: msg.channelId, data: msg.data, filename: msg.filename, mimetype: msg.mimetype, id: msg.id };
      }
      return null;

    case "ping":
      return { type: "ping" };

    case "join":
      if (typeof msg.channelId === "string" && typeof msg.id === "string") {
        return { type: "join", channelId: msg.channelId, id: msg.id };
      }
      return null;

    case "leave":
      if (typeof msg.channelId === "string" && typeof msg.id === "string") {
        return { type: "leave", channelId: msg.channelId, id: msg.id };
      }
      return null;

    case "command":
      if (
        typeof msg.channelId === "string" &&
        typeof msg.name === "string" &&
        Array.isArray(msg.args) &&
        typeof msg.id === "string"
      ) {
        return { type: "command", channelId: msg.channelId, name: msg.name, args: msg.args.map(String), id: msg.id };
      }
      return null;

    case "command_list":
      if (typeof msg.id === "string") {
        return { type: "command_list", id: msg.id };
      }
      return null;

    case "channel_list":
      if (typeof msg.id === "string") {
        return { type: "channel_list", id: msg.id };
      }
      return null;

    case "history":
      if (typeof msg.channelId === "string" && typeof msg.id === "string") {
        return {
          type: "history",
          channelId: msg.channelId,
          before: typeof msg.before === "string" ? msg.before : undefined,
          limit: typeof msg.limit === "number" ? msg.limit : undefined,
          id: msg.id,
        };
      }
      return null;

    default:
      return null;
  }
}
```

- [ ] **Step 4:** Add type guard helpers at the bottom of the file

```typescript
/** Type guard: does this message have a channelId (Team-aware)? */
export function isTeamMessage(msg: ClientMessage): msg is ClientTeamMessage | ClientTeamImage | ClientTeamFile {
  return "channelId" in msg;
}
```

- [ ] **Step 5:** Verify

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 6:** Commit

```bash
git add src/channels/ws/protocol.ts
git commit -m "feat(team): extend WS protocol with Team message types (#99)"
```

---

### Task 4: Command Registry

**Files:**
- Create: `src/team/command-registry.ts`

- [ ] **Step 1:** Create the command registry with core commands

```typescript
// src/team/command-registry.ts

import { createLogger } from "../logging/logger.js";
import type { TeamCommandHandler, TeamCommandDef, CommandContext } from "./types.js";
import type { TeamStore } from "./team-store.js";

const log = createLogger("command-registry");

export class CommandRegistry {
  private commands = new Map<string, TeamCommandHandler>();

  constructor(private teamStore: TeamStore) {
    this.registerCoreCommands();
  }

  register(handler: TeamCommandHandler): void {
    if (this.commands.has(handler.def.name)) {
      log.warn("Command already registered, overwriting", { name: handler.def.name });
    }
    this.commands.set(handler.def.name, handler);
    log.info("Command registered", { name: handler.def.name, source: handler.def.source });
  }

  get(name: string): TeamCommandHandler | undefined {
    return this.commands.get(name);
  }

  list(): TeamCommandDef[] {
    return [...this.commands.values()].map((h) => h.def);
  }

  async execute(name: string, context: CommandContext): Promise<{ found: boolean; result?: string }> {
    const handler = this.commands.get(name);
    if (!handler) return { found: false };

    try {
      const result = await handler.execute(context);
      return { found: true, result };
    } catch (err) {
      log.error("Command execution failed", { name, error: String(err) });
      return { found: true, result: `Command failed: ${String(err)}` };
    }
  }

  private registerCoreCommands(): void {
    this.register({
      def: {
        name: "help",
        source: "core",
        description: "List available commands",
      },
      execute: async () => {
        const defs = this.list();
        const lines = defs.map((d) => `  /${d.name} — ${d.description}`);
        return `Available commands:\n${lines.join("\n")}`;
      },
    });

    this.register({
      def: {
        name: "new",
        source: "core",
        description: "Create a new DM with an agent",
        args: [{ name: "agent", required: true, description: "Agent ID to start a DM with" }],
      },
      execute: async (ctx) => {
        const targetAgent = ctx.args[0];
        if (!targetAgent) return "Usage: /new <agent-id>";
        const dm = await this.teamStore.getOrCreateDm(ctx.senderId, targetAgent, ctx.senderName);
        return `DM ready: ${dm._id}`;
      },
    });

    this.register({
      def: {
        name: "rename",
        source: "core",
        description: "Rename the current channel or thread",
        args: [{ name: "name", required: true, description: "New name" }],
      },
      execute: async (ctx) => {
        const newName = ctx.args.join(" ");
        if (!newName) return "Usage: /rename <new name>";
        const ok = await this.teamStore.renameChannel(ctx.channelId, newName);
        return ok ? `Renamed to "${newName}"` : "Channel not found";
      },
    });

    this.register({
      def: {
        name: "members",
        source: "core",
        description: "List members of the current channel",
      },
      execute: async (ctx) => {
        const channel = await this.teamStore.getChannel(ctx.channelId);
        if (!channel) return "Channel not found";
        return `Members of ${channel.name}:\n${channel.members.map((m) => `  - ${m}`).join("\n")}`;
      },
    });
  }
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 3:** Commit

```bash
git add src/team/command-registry.ts
git commit -m "feat(team): add command registry with core commands (#99)"
```

---

### Task 5: WS Adapter Team Integration

**Files:**
- Modify: `src/channels/ws/ws-adapter.ts`

This is the largest task. The WS adapter needs to handle Team messages alongside legacy messages.

- [ ] **Step 1:** Add Team imports and constructor dependencies

At the top of `ws-adapter.ts`, add imports:

```typescript
import type { TeamStore } from "../../team/team-store.js";
import type { CommandRegistry } from "../../team/command-registry.js";
import type { ClientTeamMessage, ClientTeamImage, ClientTeamFile, ClientJoin, ClientLeave, ClientCommand, ClientCommandList, ClientChannelList, ClientHistory } from "./protocol.js";
import { isTeamMessage } from "./protocol.js";
import { processFileBuffer } from "../../files/file-processor.js"; // created in Step 5 — must be done first
```

Add optional Team dependencies to the constructor. To preserve backward compatibility, make them optional:

```typescript
private teamStore?: TeamStore;
private commandRegistry?: CommandRegistry;

constructor(
  port: number,
  deviceRegistry: DeviceRegistry,
  adminSecret: string,
  teamStore?: TeamStore,
  commandRegistry?: CommandRegistry,
) {
  this.port = port;
  this.deviceRegistry = deviceRegistry;
  this.adminSecret = adminSecret;
  this.teamStore = teamStore;
  this.commandRegistry = commandRegistry;
}
```

- [ ] **Step 2:** Add Team message handlers

Add a new private method after the existing message handling in `ws.on("message", ...)`. The approach: in the existing message handler, after parsing, check if it's a Team message and route to the new handler:

```typescript
private async handleTeamMessage(
  ws: WebSocket,
  msg: ClientTeamMessage,
  device: Device,
  deviceId: string,
): Promise<void> {
  this.send(ws, { type: "ack", id: msg.id });

  // Save to team_messages
  if (this.teamStore) {
    await this.teamStore.saveMessage({
      channelId: msg.channelId,
      threadId: msg.threadId,
      senderId: deviceId,
      senderType: "person",
      senderName: device.name,
      text: msg.text,
      createdAt: new Date(),
    });
  }

  // Resolve target agent from channel membership
  const channel = await this.teamStore?.getChannel(msg.channelId);
  const targetAgentId = channel?.type === "dm"
    ? channel.members.find((m) => m !== deviceId)
    : undefined;

  const workItem: WorkItem = {
    id: msg.id || randomUUID(),
    text: msg.text,
    source: {
      kind: "team",
      id: msg.channelId,
      label: `team:${channel?.name ?? msg.channelId}`,
      adapterId: "ws",
    },
    sender: deviceId,
    senderName: device.name,
    threadId: msg.threadId ?? `team:${msg.channelId}`,
    timestamp: new Date(),
    meta: {
      deviceId,
      channelId: msg.channelId,
      ...(targetAgentId ? { targetAgentId } : { defaultAgentId: device.defaultAgentId }),
    },
  };

  this.onWorkItem(workItem);
}

private async handleTeamImage(
  ws: WebSocket,
  msg: ClientTeamImage,
  device: Device,
  deviceId: string,
): Promise<void> {
  this.send(ws, { type: "ack", id: msg.id });

  const buffer = Buffer.from(msg.data, "base64");
  const mimetype = guessMimetype(msg.filename);

  try {
    const processed = await processImageBuffer(buffer, msg.filename, mimetype);

    if (this.teamStore) {
      await this.teamStore.saveMessage({
        channelId: msg.channelId,
        senderId: deviceId,
        senderType: "person",
        senderName: device.name,
        text: `[Photo: ${msg.filename}]`,
        files: [{
          name: processed.name,
          mimetype: processed.mimetype,
          size: processed.size,
          storageKey: processed.localPath,
          isImage: true,
        }],
        createdAt: new Date(),
      });
    }

    const channel = await this.teamStore?.getChannel(msg.channelId);
    const targetAgentId = channel?.type === "dm"
      ? channel.members.find((m) => m !== deviceId)
      : undefined;

    const workItem: WorkItem = {
      id: msg.id || randomUUID(),
      text: `[Photo: ${msg.filename}]`,
      source: {
        kind: "team",
        id: msg.channelId,
        label: `team:${channel?.name ?? msg.channelId}`,
        adapterId: "ws",
      },
      sender: deviceId,
      senderName: device.name,
      threadId: `team:${msg.channelId}`,
      timestamp: new Date(),
      files: [processed],
      meta: {
        deviceId,
        channelId: msg.channelId,
        ...(targetAgentId ? { targetAgentId } : { defaultAgentId: device.defaultAgentId }),
      },
    };

    this.onWorkItem(workItem);
  } catch (imgErr) {
    log.error("Team image processing failed", { deviceId, filename: msg.filename, error: String(imgErr) });
    this.send(ws, { type: "error", message: "Failed to process image" });
  }
}

private async handleTeamFile(
  ws: WebSocket,
  msg: ClientTeamFile,
  device: Device,
  deviceId: string,
): Promise<void> {
  this.send(ws, { type: "ack", id: msg.id });

  const buffer = Buffer.from(msg.data, "base64");

  try {
    // Use shared file processor — handles PDF, DOCX, XLSX, text, images
    const processed = msg.mimetype.startsWith("image/")
      ? await processImageBuffer(buffer, msg.filename, msg.mimetype)
      : await processFileBuffer(buffer, msg.filename, msg.mimetype);

    if (this.teamStore) {
      await this.teamStore.saveMessage({
        channelId: msg.channelId,
        senderId: deviceId,
        senderType: "person",
        senderName: device.name,
        text: `[File: ${msg.filename}]`,
        files: [{
          name: processed.name,
          mimetype: processed.mimetype,
          size: processed.size,
          storageKey: processed.localPath,
          isImage: processed.isImage,
        }],
        createdAt: new Date(),
      });
    }

    const channel = await this.teamStore?.getChannel(msg.channelId);
    const targetAgentId = channel?.type === "dm"
      ? channel.members.find((m) => m !== deviceId)
      : undefined;

    const workItem: WorkItem = {
      id: msg.id || randomUUID(),
      text: `[File: ${msg.filename}]`,
      source: {
        kind: "team",
        id: msg.channelId,
        label: `team:${channel?.name ?? msg.channelId}`,
        adapterId: "ws",
      },
      sender: deviceId,
      senderName: device.name,
      threadId: `team:${msg.channelId}`,
      timestamp: new Date(),
      files: [processed],
      meta: {
        deviceId,
        channelId: msg.channelId,
        ...(targetAgentId ? { targetAgentId } : { defaultAgentId: device.defaultAgentId }),
      },
    };

    this.onWorkItem(workItem);
  } catch (err) {
    log.error("Team file processing failed", { deviceId, filename: msg.filename, error: String(err) });
    this.send(ws, { type: "error", message: "Failed to process file" });
  }
}

private async handleCommand(
  ws: WebSocket,
  msg: ClientCommand,
  device: Device,
  deviceId: string,
): Promise<void> {
  this.send(ws, { type: "ack", id: msg.id });

  if (!this.commandRegistry) {
    this.send(ws, { type: "error", message: "Commands not available" });
    return;
  }

  const { found, result } = await this.commandRegistry.execute(msg.name, {
    channelId: msg.channelId,
    senderId: deviceId,
    senderName: device.name,
    args: msg.args,
  });

  if (!found) {
    // Fall through to agent as normal text
    await this.handleTeamMessage(ws, {
      type: "message",
      channelId: msg.channelId,
      text: `/${msg.name} ${msg.args.join(" ")}`.trim(),
      id: msg.id,
    }, device, deviceId);
    return;
  }

  // Save command + result as a message
  if (this.teamStore && result) {
    await this.teamStore.saveMessage({
      channelId: msg.channelId,
      senderId: "system",
      senderType: "agent",
      senderName: "system",
      text: result,
      command: { name: msg.name, args: msg.args, result },
      createdAt: new Date(),
    });
  }

  // Send result back as a regular message
  this.send(ws, {
    type: "message",
    text: result ?? "Done.",
    agentId: "system",
    agentName: "system",
    replyTo: msg.id,
  });
}

private async handleCommandList(ws: WebSocket, msg: ClientCommandList): Promise<void> {
  const commands = this.commandRegistry?.list() ?? [];
  this.send(ws, {
    type: "command_list",
    commands: commands.map((c) => ({
      name: c.name,
      description: c.description,
      args: c.args,
    })),
    id: msg.id,
  });
}

private async handleChannelList(ws: WebSocket, msg: ClientChannelList, deviceId: string): Promise<void> {
  const channels = await this.teamStore?.listChannels(deviceId) ?? [];
  this.send(ws, {
    type: "channel_list",
    channels: channels.map((c) => ({
      id: c._id,
      type: c.type,
      name: c.name,
      members: c.members,
    })),
    id: msg.id,
  });
}

private async handleHistory(ws: WebSocket, msg: ClientHistory): Promise<void> {
  if (!this.teamStore) {
    this.send(ws, { type: "error", message: "Team store not available" });
    return;
  }

  const { messages, hasMore } = await this.teamStore.getHistory(msg.channelId, {
    before: msg.before,
    limit: msg.limit,
  });

  this.send(ws, {
    type: "history",
    channelId: msg.channelId,
    messages: messages.map((m) => ({
      id: m._id ?? "",
      senderId: m.senderId,
      senderType: m.senderType,
      senderName: m.senderName,
      text: m.text,
      threadId: m.threadId,
      createdAt: m.createdAt.toISOString(),
    })),
    hasMore,
    id: msg.id,
  });
}

private async handleJoin(ws: WebSocket, msg: ClientJoin, deviceId: string): Promise<void> {
  const ok = await this.teamStore?.joinChannel(msg.channelId, deviceId);
  if (ok) {
    this.send(ws, { type: "channel_event", channelId: msg.channelId, event: "joined", detail: { memberId: deviceId }, id: msg.id });
  } else {
    this.send(ws, { type: "error", message: "Failed to join channel" });
  }
}

private async handleLeave(ws: WebSocket, msg: ClientLeave, deviceId: string): Promise<void> {
  const ok = await this.teamStore?.leaveChannel(msg.channelId, deviceId);
  if (ok) {
    this.send(ws, { type: "channel_event", channelId: msg.channelId, event: "left", detail: { memberId: deviceId }, id: msg.id });
  } else {
    this.send(ws, { type: "error", message: "Failed to leave channel" });
  }
}
```

- [ ] **Step 3:** Wire Team handlers into the main message loop

In the existing `ws.on("message", ...)` handler, after the `msg.type === "ping"` check and before the existing `msg.type === "message"` check, add Team routing:

```typescript
// Non-content Team messages — handle before isTeamMessage check
if (msg.type === "command") {
  await this.handleCommand(ws, msg, device, deviceId);
  return;
}

if (msg.type === "command_list") {
  await this.handleCommandList(ws, msg);
  return;
}

if (msg.type === "channel_list") {
  await this.handleChannelList(ws, msg, deviceId);
  return;
}

if (msg.type === "history") {
  await this.handleHistory(ws, msg);
  return;
}

if (msg.type === "join") {
  await this.handleJoin(ws, msg, deviceId);
  return;
}

if (msg.type === "leave") {
  await this.handleLeave(ws, msg, deviceId);
  return;
}

// Team content messages (message/image/file with channelId)
if (isTeamMessage(msg)) {
  if (msg.type === "message") {
    await this.handleTeamMessage(ws, msg as ClientTeamMessage, device, deviceId);
  } else if (msg.type === "image") {
    await this.handleTeamImage(ws, msg as ClientTeamImage, device, deviceId);
  } else if (msg.type === "file") {
    await this.handleTeamFile(ws, msg as ClientTeamFile, device, deviceId);
  }
  return;
}
```

- [ ] **Step 4:** Update `deliver()` to include channelId in response

In the `deliver()` method, add `channelId` to the response if it was a Team message:

```typescript
async deliver(result: WorkResult): Promise<void> {
  const deviceId = result.workItem.meta?.deviceId as string;
  if (!deviceId) {
    log.warn("No deviceId in WorkResult, cannot deliver");
    return;
  }

  const text = result.error ? `Error: ${result.error}` : result.text;
  const channelId = result.workItem.meta?.channelId as string | undefined;

  // Save agent response to team_messages if this was a Team conversation
  if (channelId && this.teamStore) {
    await this.teamStore.saveMessage({
      channelId,
      senderId: result.agentId,
      senderType: "agent",
      senderName: result.agentId,
      text,
      createdAt: new Date(),
    });
  }

  // Include channelId in response so client knows which channel it belongs to
  const msg: ServerMessage = {
    type: "message",
    text,
    agentId: result.agentId,
    agentName: result.agentId,
    replyTo: result.workItem.id,
    ...(channelId ? { channelId } : {}),
  } as ServerMessage;

  const ws = this.connections.get(deviceId);
  if (ws && ws.readyState === WebSocket.OPEN) {
    this.send(ws, msg);
  } else {
    log.info("Device not connected, buffering message", { deviceId });
    const queue = this.pendingMessages.get(deviceId) ?? [];
    queue.push(msg);
    this.pendingMessages.set(deviceId, queue);
  }
}
```

- [ ] **Step 5:** Add `processFileBuffer` to `src/files/file-processor.ts`

The file-processor currently exports `downloadAndProcess(SlackFile, botToken)` (Slack-specific) and `processImageBuffer` (images only). We need a new `processFileBuffer` that handles arbitrary file buffers (PDF, DOCX, XLSX, text, etc.) using the same extraction logic that's currently embedded in `downloadAndProcess`. **This step must be done before Steps 2-4 since those handlers import it.**

Refactor: extract the content-extraction logic (lines 145-259 of file-processor.ts — the part after download and save) into a shared function, then export it:

```typescript
// Add to src/files/file-processor.ts

/** Process a raw file buffer (non-image) into a ProcessedFile — PDF, DOCX, XLSX, text, etc. */
export async function processFileBuffer(
  buffer: Buffer,
  filename: string,
  mimetype: string,
): Promise<ProcessedFile> {
  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, "_");
  const localPath = join(DOWNLOAD_DIR, `team-${Date.now()}-${safeName}`);
  writeFileSync(localPath, buffer);

  const ext = extname(filename).slice(1).toLowerCase();
  const isImage = IMAGE_TYPES.has(ext) || mimetype.startsWith("image/");

  // Images — use processImageBuffer instead
  if (isImage) {
    return processImageBuffer(buffer, filename, mimetype);
  }

  // Text-based files
  if (TEXT_TYPES.has(ext) || mimetype.startsWith("text/")) {
    const text = buffer.toString("utf-8");
    return { name: filename, mimetype, size: buffer.length, localPath, textContent: truncate(text), isImage: false };
  }

  // PDF
  if (ext === "pdf" || mimetype === "application/pdf") {
    try {
      const pdfModule = await import("pdf-parse");
      const pdfParse = (pdfModule as any).default ?? pdfModule;
      const result = await pdfParse(buffer);
      return { name: filename, mimetype, size: buffer.length, localPath, textContent: truncate(result.text), isImage: false };
    } catch (e: any) {
      log.warn("PDF parse failed", { name: filename, error: e.message });
      return { name: filename, mimetype, size: buffer.length, localPath, textContent: "[PDF — could not extract text]", isImage: false };
    }
  }

  // DOCX
  if (ext === "docx" || mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
    try {
      const mammoth = await import("mammoth");
      const result = await mammoth.extractRawText({ buffer });
      return { name: filename, mimetype, size: buffer.length, localPath, textContent: truncate(result.value), isImage: false };
    } catch (e: any) {
      log.warn("DOCX parse failed", { name: filename, error: e.message });
      return { name: filename, mimetype, size: buffer.length, localPath, textContent: "[DOCX — could not extract text]", isImage: false };
    }
  }

  // XLSX
  if (ext === "xlsx" || ext === "xls" || mimetype.includes("spreadsheet")) {
    try {
      const XLSX = await import("xlsx");
      const workbook = XLSX.read(buffer, { type: "buffer" });
      const sheets = workbook.SheetNames.map((name) => {
        const csv = XLSX.utils.sheet_to_csv(workbook.Sheets[name]);
        return `--- Sheet: ${name} ---\n${csv}`;
      });
      return { name: filename, mimetype, size: buffer.length, localPath, textContent: truncate(sheets.join("\n\n")), isImage: false };
    } catch (e: any) {
      log.warn("XLSX parse failed", { name: filename, error: e.message });
      return { name: filename, mimetype, size: buffer.length, localPath, textContent: "[Spreadsheet — could not extract content]", isImage: false };
    }
  }

  // Unsupported
  return { name: filename, mimetype, size: buffer.length, localPath, textContent: null, isImage: false };
}
```

Note: `DOWNLOAD_DIR`, `TEXT_TYPES`, `IMAGE_TYPES`, `truncate`, `writeFileSync`, `join`, `extname` are all already in scope from the existing file. `downloadAndProcess` can be refactored to call `processFileBuffer` internally to eliminate duplication, but that's optional cleanup.

- [ ] **Step 6:** Verify

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 7:** Commit

```bash
git add src/channels/ws/ws-adapter.ts src/files/file-processor.ts
git commit -m "feat(team): integrate Team protocol into WS adapter (#99)"
```

---

### Task 6: Dispatcher Team Routing

**Files:**
- Modify: `src/channels/dispatcher.ts`

- [ ] **Step 1:** Add `resolveFromTeam()` at the beginning of `resolveAgents()`

In the `resolveAgents()` method, add a Team routing path after the explicit target check (stage 0) and before dedicated channel mapping (stage 1):

```typescript
private async resolveAgents(item: WorkItem): Promise<{ agentId: string; skipTriage: boolean }[]> {
  // 0. Explicit target — callbacks and internal routing specify exact agent
  const targetAgentId = item.meta?.targetAgentId as string | undefined;
  if (targetAgentId && this.registry.get(targetAgentId)) {
    return [{ agentId: targetAgentId, skipTriage: false }];
  }

  // 0.5 Team routing — DMs resolve to channel member, channels use @mention or triage
  if (item.source.kind === "team") {
    return this.resolveFromTeam(item);
  }

  // ... rest of existing routing unchanged
```

- [ ] **Step 2:** Implement `resolveFromTeam()`

Add as a private method on the Dispatcher class. Needs access to TeamStore, so add it as an optional dependency:

```typescript
private teamStore?: import("../team/team-store.js").TeamStore;

setTeamStore(store: import("../team/team-store.js").TeamStore): void {
  this.teamStore = store;
}

private async resolveFromTeam(item: WorkItem): Promise<{ agentId: string; skipTriage: boolean }[]> {
  const channelId = item.meta?.channelId as string | undefined;
  if (!channelId || !this.teamStore) {
    // Fall back to default agent
    const defaultId = item.meta?.defaultAgentId as string | undefined;
    if (defaultId && this.registry.get(defaultId)) return [{ agentId: defaultId, skipTriage: false }];
    return [];
  }

  const channel = await this.teamStore.getChannel(channelId);
  if (!channel) {
    log.warn("Team channel not found", { channelId });
    return [];
  }

  // DMs — route to the other member (the agent)
  if (channel.type === "dm") {
    const agentId = channel.members.find((m) => m !== item.sender);
    if (agentId && this.registry.get(agentId)) {
      return [{ agentId, skipTriage: true }]; // DMs skip triage — direct
    }
    log.warn("DM agent not found in registry", { channelId, members: channel.members });
    return [];
  }

  // Channels — check for @mentions first
  const mentioned = this.registry.findAllByName(item.text);
  if (mentioned.length > 0) {
    // Only include agents that are members of this channel
    const channelMembers = new Set(channel.members);
    const validMentions = mentioned.filter((a) => channelMembers.has(a.id));
    if (validMentions.length > 0) {
      return validMentions.map((a) => ({ agentId: a.id, skipTriage: true }));
    }
  }

  // No mention — route to first agent member of the channel (lightweight default)
  // In future, could use triage to pick best responder
  const agentMembers = channel.members.filter((m) => this.registry.get(m));
  if (agentMembers.length > 0) {
    return [{ agentId: agentMembers[0], skipTriage: false }];
  }

  log.warn("No agent members in Team channel", { channelId });
  return [];
}
```

- [ ] **Step 3:** Enable triage for Team messages

There are **two** `isInteractive` checks in dispatcher.ts — one in `dispatch()` (line 164) and one in `dispatchToAgent()` (line 429). Add `"team"` to **both**:

```typescript
// Line 164 (in dispatch()):
const isInteractive =
  (item.source.kind === "slack" || item.source.kind === "sms" || item.source.kind === "imessage" || item.source.kind === "team") &&
  item.sender !== "system";

// Line 429 (in dispatchToAgent()):
const isInteractive =
  (item.source.kind === "slack" || item.source.kind === "sms" || item.source.kind === "imessage" || item.source.kind === "team") &&
  item.sender !== "system";
```

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 5:** Commit

```bash
git add src/channels/dispatcher.ts
git commit -m "feat(team): add resolveFromTeam() routing path in dispatcher (#99)"
```

---

### Task 7: Team MCP Server (Agent-to-Agent)

**Files:**
- Create: `src/team/team-mcp-server.ts`

- [ ] **Step 1:** Create the MCP server with `send_message` and `list_agents` tools

```typescript
#!/usr/bin/env node

/**
 * Team MCP Server — lets agents send direct messages to other agents.
 *
 * Env vars (set by agent-runner):
 *   AGENT_ID      — the calling agent's ID
 *   MONGODB_URI   — MongoDB connection string
 *   MONGODB_DB    — database name
 *   AGENT_IDS     — JSON array of all agent IDs (for list_agents)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { MongoClient, ObjectId } from "mongodb";
import type { TeamMessage } from "./types.js";
import { internalChannelId } from "./types.js";

const AGENT_ID = process.env.AGENT_ID ?? "";
const MONGODB_URI = process.env.MONGODB_URI ?? "";
const MONGODB_DB = process.env.MONGODB_DB ?? "hive";
const AGENT_IDS_RAW = process.env.AGENT_IDS ?? "[]";

if (!AGENT_ID) {
  process.stderr.write("team-mcp-server: AGENT_ID is required\n");
  process.exit(1);
}
if (!MONGODB_URI) {
  process.stderr.write("team-mcp-server: MONGODB_URI is required\n");
  process.exit(1);
}

let agentIds: string[] = [];
try {
  agentIds = JSON.parse(AGENT_IDS_RAW);
} catch {
  process.stderr.write("team-mcp-server: invalid AGENT_IDS JSON\n");
}

const client = new MongoClient(MONGODB_URI);
const db = client.db(MONGODB_DB);
const messages = db.collection<TeamMessage>("team_messages");

// Shared collection for signaling — agent-to-agent request/response
const pendingRequests = db.collection("team_pending_requests");

const server = new McpServer({ name: "team", version: "1.0.0" });

// ── Tool: send_message ─────────────────────────────────────────────────

server.registerTool(
  "send_message",
  {
    title: "Send Message to Agent",
    description:
      "Send a direct message to another agent. Use this for coordination, " +
      "handoffs, or requesting information from a specialist. " +
      "Fire-and-forget by default (expectReply: false). " +
      "Set expectReply: true to wait for a response (60s timeout).",
    inputSchema: {
      targetAgentId: z.string().describe("Agent ID to send to (e.g., 'jessica', 'sige')"),
      text: z.string().describe("Message text"),
      expectReply: z.boolean().optional().default(false).describe("Wait for response? Default: false (fire-and-forget)"),
      context: z.string().optional().describe("Thread or reference context"),
    },
  },
  async ({ targetAgentId, text, expectReply, context }) => {
    if (targetAgentId === AGENT_ID) {
      return {
        content: [{ type: "text" as const, text: "Cannot send a message to yourself." }],
        isError: true,
      };
    }

    if (!agentIds.includes(targetAgentId)) {
      return {
        content: [{ type: "text" as const, text: `Unknown agent: "${targetAgentId}". Available agents: ${agentIds.join(", ")}` }],
        isError: true,
      };
    }

    const channelId = internalChannelId(AGENT_ID, targetAgentId);
    const threadId = context ?? `${Date.now()}`;

    // Save the outbound message
    await messages.insertOne({
      _id: new ObjectId().toHexString(),
      channelId,
      threadId,
      senderId: AGENT_ID,
      senderType: "agent",
      senderName: AGENT_ID,
      text,
      createdAt: new Date(),
    } as any);

    if (!expectReply) {
      // Fire-and-forget: signal dispatcher to deliver, don't wait
      await pendingRequests.insertOne({
        _id: new ObjectId().toHexString(),
        type: "fire_and_forget",
        fromAgentId: AGENT_ID,
        targetAgentId,
        text,
        channelId,
        threadId,
        createdAt: new Date(),
        status: "pending",
      });

      return {
        content: [{ type: "text" as const, text: `Message sent to ${targetAgentId}.` }],
      };
    }

    // Request/response: create a pending request and poll for reply
    const requestId = new ObjectId().toHexString();
    await pendingRequests.insertOne({
      _id: requestId,
      type: "request_response",
      fromAgentId: AGENT_ID,
      targetAgentId,
      text,
      channelId,
      threadId,
      createdAt: new Date(),
      status: "pending",
      response: null,
    });

    // Poll for response (60s timeout, 2s intervals)
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      const req = await pendingRequests.findOne({ _id: requestId });
      if (req?.status === "completed" && req.response) {
        return {
          content: [{ type: "text" as const, text: req.response as string }],
        };
      }
    }

    return {
      content: [{ type: "text" as const, text: `No response from ${targetAgentId} within 60s.` }],
      isError: true,
    };
  },
);

// ── Tool: list_agents ──────────────────────────────────────────────────

server.registerTool(
  "list_agents",
  {
    title: "List Available Agents",
    description: "List all agents available for direct messaging.",
    inputSchema: {},
  },
  async () => {
    const others = agentIds.filter((id) => id !== AGENT_ID);
    return {
      content: [{ type: "text" as const, text: `Available agents:\n${others.map((id) => `  - ${id}`).join("\n")}` }],
    };
  },
);

// ── Start ──────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 3:** Commit

```bash
git add src/team/team-mcp-server.ts
git commit -m "feat(team): add team MCP server with send_message and list_agents (#99)"
```

---

### Task 8: Agent Runner + Config Wiring

**Files:**
- Modify: `src/agents/agent-runner.ts`
- Modify: `src/config.ts`
- Modify: `src/index.ts`
- Modify: `src/plugins/types.ts`

- [ ] **Step 1:** Add Team config to `src/config.ts`

Add after the `ws` section:

```typescript
team: {
  enabled: optional("TEAM_ENABLED", "false") === "true",
},
```

- [ ] **Step 2:** Register team MCP server in `agent-runner.ts`

In `buildAllServerConfigs()`, add after the event-bus registration:

```typescript
// Team MCP server — agent-to-agent direct messaging
if (config.team.enabled) {
  const allAgentIds = this.plugins.length > 0
    ? [] // Will be populated at runtime
    : [];
  servers["team"] = {
    type: "stdio",
    command: "node",
    args: [resolve("dist/team/team-mcp-server.js")],
    env: {
      AGENT_ID: this.agentConfig.id,
      MONGODB_URI: config.mongo.uri,
      MONGODB_DB: config.mongo.dbName,
      AGENT_IDS: JSON.stringify(
        AgentRunner.registryRef?.getAll().map((a) => a.id) ?? [],
      ),
    },
  };
}
```

Also add a static registry reference so the runner can list all agent IDs:

```typescript
static registryRef?: import("./agent-registry.js").AgentRegistry;
```

Set it in index.ts during startup: `AgentRunner.registryRef = registry;`

- [ ] **Step 3:** Add `team` as an implicit core server (like `schedule`)

In `filterCoreServers()`, add:

```typescript
// team is an implicit core server when team layer is enabled
if (config.team.enabled) {
  coreSet.add("team");
}
```

- [ ] **Step 4:** Add `registerCommands` to PluginManifest and plugin-loader

In `src/plugins/types.ts`, extend the manifest:

```typescript
export interface PluginManifest {
  name: string;
  description?: string;
  mcpServers: Record<string, PluginMcpServer>;
  agentSeeds: string[];
  /** Optional: path to a JS module that exports registerCommands(registry) for Team slash commands */
  registerCommands?: string;
}
```

In `src/plugins/plugin-loader.ts`, add a function to invoke the hook after plugins are loaded. Call this from index.ts when the command registry is available:

```typescript
// Add to plugin-loader.ts
export async function registerPluginCommands(
  plugins: LoadedPlugin[],
  registry: import("../team/command-registry.js").CommandRegistry,
): Promise<void> {
  for (const plugin of plugins) {
    if (!plugin.manifest.registerCommands) continue;
    try {
      const modulePath = resolve(plugin.dir, "dist", plugin.manifest.registerCommands);
      const mod = await import(modulePath);
      if (typeof mod.registerCommands === "function") {
        mod.registerCommands(registry);
        log.info("Plugin commands registered", { plugin: plugin.name });
      }
    } catch (err) {
      log.warn("Failed to load plugin commands", { plugin: plugin.name, error: String(err) });
    }
  }
}
```

In `src/index.ts`, after creating the command registry, call:

```typescript
if (commandRegistry) {
  const { registerPluginCommands } = await import("./plugins/plugin-loader.js");
  await registerPluginCommands(plugins, commandRegistry);
}
```

- [ ] **Step 5:** Wire Team store and commands in `src/index.ts`

After the WS adapter initialization, add Team store setup:

```typescript
// Team layer — channels, DMs, commands
let teamStore: import("./team/team-store.js").TeamStore | undefined;
let commandRegistry: import("./team/command-registry.js").CommandRegistry | undefined;

if (config.team.enabled) {
  const { TeamStore } = await import("./team/team-store.js");
  const { CommandRegistry } = await import("./team/command-registry.js");

  teamStore = new TeamStore(config.mongo.uri, config.mongo.dbName);
  await teamStore.connect();

  commandRegistry = new CommandRegistry(teamStore);
  dispatcher.setTeamStore(teamStore);

  log.info("Team layer initialized");
}
```

Update the WS adapter initialization to pass Team dependencies:

```typescript
wsAdapter = new WsAdapter(config.ws.port, deviceRegistry, config.ws.jwtSecret, teamStore, commandRegistry);
```

Also set the registry ref for the Team MCP server:

```typescript
const { AgentRunner } = await import("./agents/agent-runner.js");
AgentRunner.registryRef = registry;
```

- [ ] **Step 6:** Verify

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 7:** Commit

```bash
git add src/config.ts src/agents/agent-runner.ts src/index.ts src/plugins/types.ts
git commit -m "feat(team): wire Team store, MCP server, and config (#99)"
```

---

### Task 9: Agent-to-Agent Dispatch Integration

**Files:**
- Modify: `src/scheduler/scheduler.ts` (or new file `src/team/team-dispatcher.ts`)

The `team_pending_requests` collection needs to be polled and dispatched, similar to how the scheduler polls `agent_events` and `agent_callbacks`.

- [ ] **Step 1:** Add team request polling to the scheduler

Add a new polling method in the scheduler (alongside the existing event and callback polling):

```typescript
private async fireTeamRequests(): Promise<void> {
  if (!config.team.enabled) return;

  const pending = await this.db
    .collection("team_pending_requests")
    .find({ status: "pending" })
    .toArray();

  for (const req of pending) {
    // Atomically mark as fired
    const updated = await this.db.collection("team_pending_requests").findOneAndUpdate(
      { _id: req._id, status: "pending" },
      { $set: { status: "fired", firedAt: new Date() } },
    );
    if (!updated) continue;

    const item: WorkItem = {
      id: `team-${req._id}`,
      text: req.text,
      source: {
        kind: "internal",
        id: req.channelId,
        label: `internal:${req.fromAgentId}→${req.targetAgentId}`,
      },
      sender: req.fromAgentId,
      senderName: req.fromAgentId,
      threadId: `internal:${req.channelId}:${req.threadId}`,
      timestamp: new Date(),
      meta: {
        targetAgentId: req.targetAgentId,
        teamRequestId: req._id,
        teamRequestType: req.type,
      },
    };

    try {
      if (req.type === "fire_and_forget") {
        this.agentManager.sendMessage(req.targetAgentId, item).catch((err: unknown) =>
          log.error("Fire-and-forget team message failed", { target: req.targetAgentId, error: String(err) }),
        );
      } else if (req.type === "request_response") {
        // For request/response, we need to capture the response
        const result = await this.agentManager.sendMessage(req.targetAgentId, item);

        // Save the response to team_messages
        await this.db.collection("team_messages").insertOne({
          _id: new ObjectId().toHexString(),
          channelId: req.channelId,
          threadId: req.threadId,
          senderId: req.targetAgentId,
          senderType: "agent",
          senderName: req.targetAgentId,
          text: result.text,
          createdAt: new Date(),
        });

        // Signal the waiting send_message tool
        await this.db.collection("team_pending_requests").updateOne(
          { _id: req._id },
          { $set: { status: "completed", response: result.text } },
        );
      }
    } catch (err) {
      log.error("Team request dispatch failed", {
        requestId: req._id,
        target: req.targetAgentId,
        error: String(err),
      });
      // Mark as failed so it's not retried
      await this.db.collection("team_pending_requests").updateOne(
        { _id: req._id },
        { $set: { status: "failed", error: String(err) } },
      );
    }
  }
}
```

- [ ] **Step 2:** Add a new `setInterval` timer for team requests in `start()`

The scheduler uses separate `setInterval` timers for cron, callbacks, and events. Add a new one for team requests (alongside the callback timer at ~line 147):

```typescript
// Add class property
private teamTimer: ReturnType<typeof setInterval> | null = null;

// In start(), after the eventTimer setup:
if (config.team.enabled) {
  this.teamTimer = setInterval(() => {
    this.fireTeamRequests().catch((err) =>
      log.error("Team request check failed", { error: String(err) }),
    );
  }, 5_000); // 5s polling — faster than events (30s) since request/response needs low latency
}

// In stop(), clear the timer:
if (this.teamTimer) clearInterval(this.teamTimer);
```

- [ ] **Step 3:** Add index and TTL cleanup for team_pending_requests

First, create an index (add to scheduler's `connectDb` or startup):

```typescript
await this.db.collection("team_pending_requests").createIndex({ status: 1, createdAt: -1 });
```

Then add TTL cleanup for completed/failed requests:

```typescript
// In the scheduler's sweep, clean up old team requests (older than 1 hour)
await this.db.collection("team_pending_requests").deleteMany({
  status: { $in: ["completed", "failed"] },
  createdAt: { $lt: new Date(Date.now() - 3600_000) },
});
```

- [ ] **Step 4:** Verify

Run: `npx tsc --noEmit`
Expected: Clean compile

- [ ] **Step 5:** Commit

```bash
git add src/scheduler/scheduler.ts
git commit -m "feat(team): add agent-to-agent request dispatch to scheduler (#99)"
```

---

### Task 10: Tests

**Files:**
- Create: `src/team/team-store.test.ts`
- Create: `src/team/command-registry.test.ts`
- Create: `src/channels/ws/protocol.test.ts` (extend if exists)

- [ ] **Step 1:** Test TeamStore basics

```typescript
// src/team/team-store.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { TeamStore } from "./team-store.js";
import { MongoClient } from "mongodb";

const TEST_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const TEST_DB = "hive_test_team";

describe("TeamStore", () => {
  let store: TeamStore;

  beforeAll(async () => {
    store = new TeamStore(TEST_URI, TEST_DB);
    await store.connect();
  });

  afterAll(async () => {
    const client = new MongoClient(TEST_URI);
    await client.connect();
    await client.db(TEST_DB).dropDatabase();
    await client.close();
    await store.close();
  });

  it("creates and retrieves a DM", async () => {
    const dm = await store.getOrCreateDm("device-1", "jessica", "Test User");
    expect(dm._id).toBe("dm:device-1:jessica");
    expect(dm.type).toBe("dm");
    expect(dm.members).toEqual(["device-1", "jessica"]);

    // Idempotent
    const dm2 = await store.getOrCreateDm("jessica", "device-1", "Jessica");
    expect(dm2._id).toBe(dm._id);
  });

  it("creates a channel and manages membership", async () => {
    await store.createChannel({
      _id: "test-channel",
      type: "channel",
      name: "#test",
      members: ["agent-a"],
      createdBy: "admin",
      createdAt: new Date(),
      updatedAt: new Date(),
      archived: false,
    });

    await store.joinChannel("test-channel", "agent-b");
    const channel = await store.getChannel("test-channel");
    expect(channel?.members).toContain("agent-b");

    await store.leaveChannel("test-channel", "agent-a");
    const updated = await store.getChannel("test-channel");
    expect(updated?.members).not.toContain("agent-a");
  });

  it("saves and retrieves message history", async () => {
    await store.getOrCreateDm("user-1", "agent-1", "User");

    for (let i = 0; i < 5; i++) {
      await store.saveMessage({
        channelId: "dm:agent-1:user-1",
        senderId: i % 2 === 0 ? "user-1" : "agent-1",
        senderType: i % 2 === 0 ? "person" : "agent",
        senderName: i % 2 === 0 ? "User" : "Agent",
        text: `Message ${i}`,
        createdAt: new Date(Date.now() + i * 1000),
      });
    }

    const { messages, hasMore } = await store.getHistory("dm:agent-1:user-1", { limit: 3 });
    expect(messages).toHaveLength(3);
    expect(hasMore).toBe(true);
    expect(messages[0].text).toBe("Message 0");
  });
});
```

- [ ] **Step 2:** Test CommandRegistry

```typescript
// src/team/command-registry.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { CommandRegistry } from "./command-registry.js";
import { TeamStore } from "./team-store.js";
import { MongoClient } from "mongodb";

const TEST_URI = process.env.MONGODB_URI ?? "mongodb://localhost:27017";
const TEST_DB = "hive_test_commands";

describe("CommandRegistry", () => {
  let store: TeamStore;
  let registry: CommandRegistry;

  beforeAll(async () => {
    store = new TeamStore(TEST_URI, TEST_DB);
    await store.connect();
    registry = new CommandRegistry(store);
  });

  afterAll(async () => {
    const client = new MongoClient(TEST_URI);
    await client.connect();
    await client.db(TEST_DB).dropDatabase();
    await client.close();
    await store.close();
  });

  it("has core commands registered", () => {
    const commands = registry.list();
    const names = commands.map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("new");
    expect(names).toContain("rename");
    expect(names).toContain("members");
  });

  it("executes /help and returns command list", async () => {
    const { found, result } = await registry.execute("help", {
      channelId: "test",
      senderId: "user",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(true);
    expect(result).toContain("/help");
    expect(result).toContain("/new");
  });

  it("returns found=false for unknown commands", async () => {
    const { found } = await registry.execute("nonexistent", {
      channelId: "test",
      senderId: "user",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(false);
  });

  it("accepts custom skill commands", () => {
    registry.register({
      def: { name: "order-status", source: "skill", description: "Check order status" },
      execute: async (ctx) => `Order ${ctx.args[0]} is shipped`,
    });

    const commands = registry.list();
    expect(commands.find((c) => c.name === "order-status")).toBeDefined();
  });
});
```

- [ ] **Step 3:** Test protocol parsing

```typescript
// src/channels/ws/protocol.test.ts
import { describe, it, expect } from "vitest";
import { parseClientMessage, isTeamMessage } from "./protocol.js";

describe("parseClientMessage — Team extensions", () => {
  it("parses Team message (message with channelId)", () => {
    const msg = parseClientMessage(JSON.stringify({
      type: "message",
      channelId: "dm:a:b",
      text: "hello",
      id: "m1",
    }));
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("message");
    expect(isTeamMessage(msg!)).toBe(true);
    expect((msg as any).channelId).toBe("dm:a:b");
  });

  it("parses legacy message (no channelId)", () => {
    const msg = parseClientMessage(JSON.stringify({
      type: "message",
      text: "hello",
      id: "m1",
    }));
    expect(msg).toBeTruthy();
    expect(isTeamMessage(msg!)).toBe(false);
  });

  it("parses file message", () => {
    const msg = parseClientMessage(JSON.stringify({
      type: "file",
      channelId: "general",
      data: "base64data",
      filename: "doc.pdf",
      mimetype: "application/pdf",
      id: "f1",
    }));
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("file");
  });

  it("parses command", () => {
    const msg = parseClientMessage(JSON.stringify({
      type: "command",
      channelId: "general",
      name: "help",
      args: [],
      id: "c1",
    }));
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("command");
  });

  it("parses history request", () => {
    const msg = parseClientMessage(JSON.stringify({
      type: "history",
      channelId: "general",
      before: "abc123",
      limit: 25,
      id: "h1",
    }));
    expect(msg).toBeTruthy();
    expect(msg!.type).toBe("history");
  });

  it("returns null for invalid messages", () => {
    expect(parseClientMessage("not json")).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "unknown" }))).toBeNull();
    expect(parseClientMessage(JSON.stringify({ type: "file" }))).toBeNull(); // missing fields
  });
});
```

- [ ] **Step 4:** Verify

Run: `npm run test`
Expected: All tests pass

- [ ] **Step 5:** Commit

```bash
git add src/team/team-store.test.ts src/team/command-registry.test.ts src/channels/ws/protocol.test.ts
git commit -m "test(team): add tests for TeamStore, CommandRegistry, and protocol parsing (#99)"
```

---

### Task 11: Quality Gate

- [ ] **Step 1:** Run full check suite

Run: `npm run check`
Expected: typecheck + lint + format + test all pass

- [ ] **Step 2:** Fix any issues

- [ ] **Step 3:** Final commit if fixes were needed

```bash
git commit -m "chore(team): quality gate fixes (#99)"
```
