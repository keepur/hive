import { createServer, type Server, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logging/logger.js";
import type { ChannelAdapter } from "../channel-adapter.js";
import type { WorkItem, WorkResult, ChannelKind } from "../../types/work-item.js";
import type {
  ServerMessage,
  ClientTeamMessage,
  ClientTeamImage,
  ClientTeamFile,
  ClientJoin,
  ClientLeave,
  ClientCommand,
  ClientCommandList,
  ClientChannelList,
  ClientHistory,
  AgentInfo,
} from "./protocol.js";
import { parseClientMessage, isTeamMessage } from "./protocol.js";
import { processImageBuffer, processFileBuffer } from "../../files/file-processor.js";
import type { TeamStore } from "../../team/team-store.js";
import type { CommandRegistry } from "../../team/command-registry.js";
import type { AgentRegistry } from "../../agents/agent-registry.js";
import type { AgentManager } from "../../agents/agent-manager.js";

const log = createLogger("ws-adapter");

/**
 * Synthetic device identity for the WS connection. Post-Phase-B, Hive's WS
 * adapter no longer owns a device registry — `@keepur/beekeeper` does. The
 * upgrade handler receives `deviceId`, `label` (cosmetic display name), and
 * `user` (server-asserted identity, JWT-verified upstream) as loopback query
 * params from the Beekeeper team proxy and builds this struct on the fly.
 * `user` is optional during the transition — older deployed beekeepers don't
 * emit it yet.
 */
interface Device {
  _id: string;
  label: string;
  user?: string;
  defaultAgentId: string;
  origin?: string;
}

export interface WsAdapterDeps {
  teamStore: TeamStore;
  commandRegistry: CommandRegistry;
  agentRegistry: AgentRegistry;
  agentManager: AgentManager;
}

export class WsAdapter implements ChannelAdapter {
  readonly id = "ws";
  readonly kind: ChannelKind = "app";

  private port: number;
  private server!: Server;
  private wss!: WebSocketServer;
  private connections = new Map<string, WebSocket>(); // deviceId -> ws
  private pendingMessages = new Map<string, ServerMessage[]>(); // deviceId -> queued messages
  private onWorkItem!: (item: WorkItem) => void;
  private teamStore: TeamStore;
  private commandRegistry: CommandRegistry;
  private agentRegistry: AgentRegistry;
  private agentManager: AgentManager;

  constructor(port: number, deps: WsAdapterDeps) {
    this.port = port;
    this.teamStore = deps.teamStore;
    this.commandRegistry = deps.commandRegistry;
    this.agentRegistry = deps.agentRegistry;
    this.agentManager = deps.agentManager;
  }

  async start(onWorkItem: (item: WorkItem) => void): Promise<void> {
    this.onWorkItem = onWorkItem;

    this.server = createServer(async (req, res) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);

      // GET /health — the only HTTP surface. Pair, /me, and /devices all
      // live in @keepur/beekeeper now.
      if (req.method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", connections: this.connections.size }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    // WebSocket server — handle upgrade manually for auth
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 10 * 1024 * 1024 }); // 10 MB max message size

    this.server.on("upgrade", (req, socket, head) => {
      const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);

      // Only path in or out: loopback-only internal proxy from sibling
      // Beekeeper, which terminates external auth and forwards frames over
      // 127.0.0.1. We trust the connection on loopback and read deviceId /
      // name off query params. The adapter also binds to 127.0.0.1 only, so
      // the loopback check is defense in depth — the OS-level bind is the
      // primary gate, but we keep the check in case bind config drifts.
      if (url.searchParams.get("internal") !== "1") {
        socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
        socket.destroy();
        return;
      }

      const remote = req.socket.remoteAddress ?? "";
      const isLoopback = remote === "127.0.0.1" || remote === "::1" || remote === "::ffff:127.0.0.1";
      if (!isLoopback) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }

      const deviceId = url.searchParams.get("deviceId");
      // Transitional: deployed beekeeper still sends `name=`. Beekeeper PR #11
      // renamed it to `label=`. Accept either; remove the `name` fallback in a
      // follow-up once both sides are deployed.
      const label = url.searchParams.get("label") ?? url.searchParams.get("name");
      // Server-asserted identity from beekeeper (after JWT verification).
      // Optional during rollout — deployed beekeeper doesn't emit it yet.
      const user = url.searchParams.get("user") ?? undefined;
      if (!deviceId || !label) {
        socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
        socket.destroy();
        return;
      }

      const origin = url.searchParams.get("origin") ?? undefined;

      // Synthetic device — loopback traffic comes from beekeeper's team proxy.
      // Routing on the app path uses meta.origin, populated below from the
      // connection-level origin tag that beekeeper forwards via query param.
      const device: Device = { _id: deviceId, label, user, defaultAgentId: "", origin };
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req, device);
      });
    });

    this.wss.on("connection", (ws: WebSocket, _req: IncomingMessage, device: Device) => {
      const deviceId = device._id;
      log.info("Device connected", { deviceId, label: device.label });

      // Drain any pending messages from before reconnect
      const pending = this.pendingMessages.get(deviceId);
      if (pending?.length) {
        log.info("Draining pending messages", { deviceId, count: pending.length });
        for (const msg of pending) {
          this.send(ws, msg);
        }
        this.pendingMessages.delete(deviceId);
      }

      // Close existing connection for this device (reconnect scenario)
      const existing = this.connections.get(deviceId);
      if (existing) {
        existing.close(1000, "Replaced by new connection");
      }
      this.connections.set(deviceId, ws);

      ws.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const msg = parseClientMessage(raw.toString());
          if (!msg) {
            this.send(ws, { type: "error", message: "Invalid message format" });
            return;
          }

          if (msg.type === "ping") {
            return;
          }

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
            await this.handleHistory(ws, msg, deviceId);
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

          if (msg.type === "agent_list") {
            const agents = this.buildAgentList();
            this.send(ws, { type: "agent_list", agents, id: msg.id });
            return;
          }

          // Team content messages (message/image/file with channelId).
          // Note: identity comes from `device.user` (URL-asserted upstream by
          // beekeeper JWT verification). Any `user` field inside the frame is
          // client-supplied and MUST be ignored — parseClientMessage drops it
          // via its typed schema.
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

          if (msg.type === "message") {
            this.send(ws, { type: "ack", id: msg.id });

            const workItem: WorkItem = {
              id: msg.id || randomUUID(),
              text: msg.text,
              source: {
                kind: "app",
                id: deviceId,
                label: `app:${device.label}`,
                adapterId: "ws",
              },
              sender: deviceId,
              senderName: device.label,
              threadId: `app:${deviceId}`,
              timestamp: new Date(),
              meta: {
                deviceId,
                defaultAgentId: device.defaultAgentId,
                origin: device.origin,
              },
            };

            this.onWorkItem(workItem);
          }

          if (msg.type === "image") {
            this.send(ws, { type: "ack", id: msg.id });

            const buffer = Buffer.from(msg.data, "base64");
            const mimetype = guessMimetype(msg.filename);

            try {
              const processed = await processImageBuffer(buffer, msg.filename, mimetype);

              const workItem: WorkItem = {
                id: msg.id || randomUUID(),
                text: `[Photo: ${msg.filename}]`,
                source: {
                  kind: "app",
                  id: deviceId,
                  label: `app:${device.label}`,
                  adapterId: "ws",
                },
                sender: deviceId,
                senderName: device.label,
                threadId: `app:${deviceId}`,
                timestamp: new Date(),
                files: [processed],
                meta: {
                  deviceId,
                  defaultAgentId: device.defaultAgentId,
                  origin: device.origin,
                },
              };

              this.onWorkItem(workItem);
            } catch (imgErr) {
              log.error("Image processing failed", { deviceId, filename: msg.filename, error: String(imgErr) });
              this.send(ws, { type: "error", message: "Failed to process image" });
            }
          }
        } catch (err) {
          log.error("Message handling error", { deviceId, error: String(err) });
          this.send(ws, { type: "error", message: "Internal error" });
        }
      });

      ws.on("close", () => {
        log.info("Device disconnected", { deviceId });
        this.connections.delete(deviceId);
      });

      ws.on("error", (err) => {
        log.error("WebSocket error", { deviceId, error: String(err) });
      });
    });

    await new Promise<void>((resolve) => {
      this.server.listen(this.port, "127.0.0.1", () => {
        log.info("WebSocket server listening", { port: this.port, host: "127.0.0.1" });
        resolve();
      });
    });
  }

  async deliver(result: WorkResult): Promise<void> {
    const deviceId = result.workItem.meta?.deviceId as string;
    if (!deviceId) {
      log.warn("No deviceId in WorkResult, cannot deliver");
      return;
    }

    const text = result.error ? `Error: ${result.error}` : result.text;
    const channelId = result.workItem.meta?.channelId as string | undefined;

    // Resolve the human-readable display name for the handling agent. Falls
    // back to the id if the agent isn't in the registry (shouldn't happen in
    // practice — the dispatcher already resolved this agent to deliver the
    // result — but the fallback keeps us honest and avoids blank strings in
    // client chat headers).
    const agentName = this.agentRegistry.get(result.agentId)?.name ?? result.agentId;

    // Save agent response to team_messages if this was a Team conversation
    if (channelId) {
      await this.teamStore.saveMessage({
        channelId,
        senderId: result.agentId,
        senderType: "agent",
        senderName: agentName,
        text,
        createdAt: new Date(),
      });
    }

    // Include channelId in response so client knows which channel it belongs to
    const msg: ServerMessage = {
      type: "message",
      text,
      agentId: result.agentId,
      agentName,
      replyTo: result.workItem.id,
      ...(channelId ? { channelId } : {}),
    };

    const ws = this.connections.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.send(ws, msg);
    } else {
      // Buffer for delivery when device reconnects
      log.info("Device not connected, buffering message", { deviceId });
      const queue = this.pendingMessages.get(deviceId) ?? [];
      queue.push(msg);
      this.pendingMessages.set(deviceId, queue);
    }
  }

  async onProcessingStart(item: WorkItem, agentId: string): Promise<void> {
    // The dispatcher passes the resolved handler id directly — we no longer
    // need to re-derive it from `item.meta`. Pre-KPR-12 this function used a
    // `"unknown"` literal fallback and an early-return for app-source items
    // because triage hadn't resolved yet; both are now unnecessary and have
    // been removed.
    const deviceId = item.meta?.deviceId as string;
    if (!deviceId) return;

    const ws = this.connections.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.send(ws, { type: "typing", agentId });
    }
  }

  async onProcessingEnd(_item: WorkItem, _agentId: string): Promise<void> {
    // No-op — typing indicator is implicitly cleared when the message arrives
  }

  async stop(): Promise<void> {
    for (const [_id, ws] of this.connections) {
      ws.close(1001, "Server shutting down");
    }
    this.connections.clear();

    await new Promise<void>((resolve) => {
      if (this.wss) this.wss.close(() => {});
      if (this.server) this.server.close(() => resolve());
      else resolve();
    });

    log.info("WebSocket adapter stopped");
  }

  /** Number of currently connected devices */
  get connectionCount(): number {
    return this.connections.size;
  }

  // ── Team helpers ───────────────────────────────────────────────────

  /** Verify device is a member of the channel. Returns the channel on success, null on failure. */
  private async verifyChannelMembership(
    ws: WebSocket,
    channelId: string,
    deviceId: string,
  ): Promise<import("../../team/types.js").TeamChannel | null> {
    const channel = await this.teamStore.getChannel(channelId);
    if (!channel) {
      this.send(ws, { type: "error", message: "Channel not found" });
      return null;
    }
    if (!channel.members.includes(deviceId)) {
      this.send(ws, { type: "error", message: "Not a member of this channel" });
      return null;
    }
    return channel;
  }

  /** Build the agent roster with runtime status for client consumption. */
  private buildAgentList(): AgentInfo[] {
    return this.agentRegistry.getAll().map((agent) => {
      const state = this.agentManager.getState(agent.id);
      return {
        id: agent.id,
        name: agent.name,
        icon: agent.icon,
        title: agent.title ?? null,
        model: agent.model,
        status: state?.status ?? "idle",
        tools: [...new Set([...agent.coreServers, ...agent.delegateServers])].sort(),
        schedule: agent.schedule.map((s) => ({ cron: s.cron, task: s.task })),
        channels: agent.channels,
        messagesProcessed: state?.messagesProcessed ?? 0,
        lastActivity: state ? state.lastActivity.toISOString() : null,
      };
    });
  }

  // ── Team message handlers ──────────────────────────────────────────

  private async handleTeamMessage(
    ws: WebSocket,
    msg: ClientTeamMessage,
    device: Device,
    deviceId: string,
  ): Promise<void> {
    this.send(ws, { type: "ack", id: msg.id });

    const channel = await this.verifyChannelMembership(ws, msg.channelId, deviceId);
    if (!channel) return;

    // Save to team_messages
    await this.teamStore.saveMessage({
      channelId: msg.channelId,
      threadId: msg.threadId,
      senderId: deviceId,
      senderType: "person",
      senderName: device.label,
      text: msg.text,
      createdAt: new Date(),
    });

    // Resolve target agent from channel membership
    const targetAgentId = channel.type === "dm" ? channel.members.find((m) => m !== deviceId) : undefined;

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
      senderName: device.label,
      threadId: msg.threadId ?? `team:${msg.channelId}`,
      timestamp: new Date(),
      meta: {
        deviceId,
        channelId: msg.channelId,
        ...(device.user ? { user: device.user } : {}),
        ...(targetAgentId ? { targetAgentId } : { defaultAgentId: device.defaultAgentId }),
      },
    };

    this.onWorkItem(workItem);
  }

  private async handleTeamImage(ws: WebSocket, msg: ClientTeamImage, device: Device, deviceId: string): Promise<void> {
    this.send(ws, { type: "ack", id: msg.id });

    const channel = await this.verifyChannelMembership(ws, msg.channelId, deviceId);
    if (!channel) return;

    const buffer = Buffer.from(msg.data, "base64");
    const mimetype = guessMimetype(msg.filename);

    try {
      const processed = await processImageBuffer(buffer, msg.filename, mimetype);

      await this.teamStore.saveMessage({
        channelId: msg.channelId,
        senderId: deviceId,
        senderType: "person",
        senderName: device.label,
        text: `[Photo: ${msg.filename}]`,
        files: [
          {
            name: processed.name,
            mimetype: processed.mimetype,
            size: processed.size,
            storageKey: processed.localPath,
            isImage: true,
          },
        ],
        createdAt: new Date(),
      });

      const targetAgentId = channel.type === "dm" ? channel.members.find((m) => m !== deviceId) : undefined;

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
        senderName: device.label,
        threadId: `team:${msg.channelId}`,
        timestamp: new Date(),
        files: [processed],
        meta: {
          deviceId,
          channelId: msg.channelId,
          ...(device.user ? { user: device.user } : {}),
          ...(targetAgentId ? { targetAgentId } : { defaultAgentId: device.defaultAgentId }),
        },
      };

      this.onWorkItem(workItem);
    } catch (imgErr) {
      log.error("Team image processing failed", {
        deviceId,
        filename: msg.filename,
        error: String(imgErr),
      });
      this.send(ws, { type: "error", message: "Failed to process image" });
    }
  }

  private async handleTeamFile(ws: WebSocket, msg: ClientTeamFile, device: Device, deviceId: string): Promise<void> {
    this.send(ws, { type: "ack", id: msg.id });

    const channel = await this.verifyChannelMembership(ws, msg.channelId, deviceId);
    if (!channel) return;

    const buffer = Buffer.from(msg.data, "base64");

    try {
      // Use shared file processor — handles PDF, DOCX, XLSX, text, images
      const processed = msg.mimetype.startsWith("image/")
        ? await processImageBuffer(buffer, msg.filename, msg.mimetype)
        : await processFileBuffer(buffer, msg.filename, msg.mimetype);

      await this.teamStore.saveMessage({
        channelId: msg.channelId,
        senderId: deviceId,
        senderType: "person",
        senderName: device.label,
        text: `[File: ${msg.filename}]`,
        files: [
          {
            name: processed.name,
            mimetype: processed.mimetype,
            size: processed.size,
            storageKey: processed.localPath,
            isImage: processed.isImage,
          },
        ],
        createdAt: new Date(),
      });

      const targetAgentId = channel.type === "dm" ? channel.members.find((m) => m !== deviceId) : undefined;

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
        senderName: device.label,
        threadId: `team:${msg.channelId}`,
        timestamp: new Date(),
        files: [processed],
        meta: {
          deviceId,
          channelId: msg.channelId,
          ...(device.user ? { user: device.user } : {}),
          ...(targetAgentId ? { targetAgentId } : { defaultAgentId: device.defaultAgentId }),
        },
      };

      this.onWorkItem(workItem);
    } catch (err) {
      log.error("Team file processing failed", {
        deviceId,
        filename: msg.filename,
        error: String(err),
      });
      this.send(ws, { type: "error", message: "Failed to process file" });
    }
  }

  private async handleCommand(ws: WebSocket, msg: ClientCommand, device: Device, deviceId: string): Promise<void> {
    this.send(ws, { type: "ack", id: msg.id });

    // Unknown command → explicit error, no fallthrough to handleTeamMessage
    // (KPR-11: fallthrough previously produced the misleading "Channel not found").
    if (!this.commandRegistry.has(msg.name)) {
      this.send(ws, { type: "error", message: `Unknown command: /${msg.name}` });
      return;
    }

    const { result } = await this.commandRegistry.execute(msg.name, {
      channelId: msg.channelId,
      senderId: deviceId,
      senderName: device.label,
      args: msg.args,
    });

    // Save command + result as a message
    if (result) {
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
    const commands = this.commandRegistry.list();
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
    const channels = await this.teamStore.listChannels(deviceId);
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

  private async handleHistory(ws: WebSocket, msg: ClientHistory, deviceId: string): Promise<void> {
    if (!(await this.verifyChannelMembership(ws, msg.channelId, deviceId))) return;

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
    // DM channels are private — only the two original participants may be members
    if (msg.channelId.startsWith("dm:")) {
      const channel = await this.teamStore.getChannel(msg.channelId);
      if (!channel || !channel.members.includes(deviceId)) {
        this.send(ws, { type: "error", message: "Cannot join a DM you are not part of" });
        return;
      }
    }
    // Non-DM channels are open-join for now (agents/devices can self-add)
    const ok = await this.teamStore.joinChannel(msg.channelId, deviceId);
    if (ok) {
      this.send(ws, {
        type: "channel_event",
        channelId: msg.channelId,
        event: "joined",
        detail: { memberId: deviceId },
        id: msg.id,
      });
    } else {
      this.send(ws, { type: "error", message: "Failed to join channel" });
    }
  }

  private async handleLeave(ws: WebSocket, msg: ClientLeave, deviceId: string): Promise<void> {
    const ok = await this.teamStore.leaveChannel(msg.channelId, deviceId);
    if (ok) {
      this.send(ws, {
        type: "channel_event",
        channelId: msg.channelId,
        event: "left",
        detail: { memberId: deviceId },
        id: msg.id,
      });
    } else {
      this.send(ws, { type: "error", message: "Failed to leave channel" });
    }
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

/** Guess MIME type from filename extension. */
function guessMimetype(filename: string): string {
  const ext = filename.split(".").pop()?.toLowerCase();
  const map: Record<string, string> = {
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    png: "image/png",
    gif: "image/gif",
    webp: "image/webp",
    heic: "image/heic",
  };
  return map[ext ?? ""] ?? "image/jpeg";
}
