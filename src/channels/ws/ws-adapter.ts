import { createServer, type Server, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logging/logger.js";
import type { ChannelAdapter } from "../channel-adapter.js";
import type { WorkItem, WorkResult, ChannelKind } from "../../types/work-item.js";
import type { DeviceRegistry, Device } from "./device-registry.js";
import type { ServerMessage } from "./protocol.js";
import { parseClientMessage } from "./protocol.js";
import { processImageBuffer } from "../../files/file-processor.js";

const log = createLogger("ws-adapter");

export class WsAdapter implements ChannelAdapter {
  readonly id = "ws";
  readonly kind: ChannelKind = "app" as ChannelKind; // Cast needed until ChannelKind is updated

  private port: number;
  private deviceRegistry: DeviceRegistry;
  private server!: Server;
  private wss!: WebSocketServer;
  private connections = new Map<string, WebSocket>(); // deviceId -> ws
  private onWorkItem!: (item: WorkItem) => void;

  constructor(port: number, deviceRegistry: DeviceRegistry) {
    this.port = port;
    this.deviceRegistry = deviceRegistry;
  }

  async start(onWorkItem: (item: WorkItem) => void): Promise<void> {
    this.onWorkItem = onWorkItem;

    this.server = createServer(async (req, res) => {
      // CORS headers
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

      if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
      }

      // POST /pair — exchange pairing code for JWT
      if (req.method === "POST" && req.url === "/pair") {
        try {
          const body = await readBody(req);
          let parsed: { code?: string };
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }

          if (!parsed.code || typeof parsed.code !== "string") {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Missing required field: code" }));
            return;
          }

          const result = await this.deviceRegistry.verifyPairingCode(parsed.code);
          if (!result) {
            res.writeHead(401, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid or expired pairing code" }));
            return;
          }

          log.info("Device paired", { deviceId: result.device._id, name: result.device.name });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            token: result.token,
            deviceId: result.device._id,
            deviceName: result.device.name,
          }));
        } catch (err) {
          log.error("Pair endpoint error", { error: String(err) });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
        return;
      }

      // GET /health
      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "ok", connections: this.connections.size }));
        return;
      }

      res.writeHead(404);
      res.end("Not found");
    });

    // WebSocket server — handle upgrade manually for auth
    this.wss = new WebSocketServer({ noServer: true });

    this.server.on("upgrade", async (req, socket, head) => {
      // Extract token from query string ?token=... or Authorization header
      const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
      const token =
        url.searchParams.get("token") ??
        req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const device = await this.deviceRegistry.verifyToken(token);
      if (!device) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      this.wss.handleUpgrade(req, socket, head, (ws) => {
        this.wss.emit("connection", ws, req, device);
      });
    });

    this.wss.on("connection", (ws: WebSocket, _req: IncomingMessage, device: Device) => {
      const deviceId = device._id;
      log.info("Device connected", { deviceId, name: device.name });

      // Close existing connection for this device (reconnect scenario)
      const existing = this.connections.get(deviceId);
      if (existing) {
        existing.close(1000, "Replaced by new connection");
      }
      this.connections.set(deviceId, ws);
      this.deviceRegistry.updateLastSeen(deviceId);

      ws.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
        try {
          const msg = parseClientMessage(raw.toString());
          if (!msg) {
            this.send(ws, { type: "error", message: "Invalid message format" });
            return;
          }

          if (msg.type === "ping") {
            this.deviceRegistry.updateLastSeen(deviceId);
            return;
          }

          if (msg.type === "message") {
            this.send(ws, { type: "ack", id: msg.id });

            const workItem: WorkItem = {
              id: msg.id || randomUUID(),
              text: msg.text,
              source: {
                kind: "app" as ChannelKind,
                id: deviceId,
                label: `app:${device.name}`,
                adapterId: "ws",
              },
              sender: deviceId,
              senderName: device.name,
              threadId: `app:${deviceId}`,
              timestamp: new Date(),
              meta: {
                deviceId,
                defaultAgentId: device.defaultAgentId,
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
                  kind: "app" as ChannelKind,
                  id: deviceId,
                  label: `app:${device.name}`,
                  adapterId: "ws",
                },
                sender: deviceId,
                senderName: device.name,
                threadId: `app:${deviceId}`,
                timestamp: new Date(),
                files: [processed],
                meta: {
                  deviceId,
                  defaultAgentId: device.defaultAgentId,
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
      this.server.listen(this.port, () => {
        log.info("WebSocket server listening", { port: this.port });
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

    const ws = this.connections.get(deviceId);
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      log.warn("Device not connected, dropping message", { deviceId });
      return;
    }

    const text = result.error
      ? `Error: ${result.error}`
      : result.text;

    this.send(ws, {
      type: "message",
      text,
      agentId: result.agentId,
      agentName: result.agentId, // TODO: resolve display name from agent registry
      replyTo: result.workItem.id,
    });
  }

  async onProcessingStart(item: WorkItem): Promise<void> {
    const deviceId = item.meta?.deviceId as string;
    if (!deviceId) return;

    const ws = this.connections.get(deviceId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      this.send(ws, {
        type: "typing",
        agentId: (item.meta?.defaultAgentId as string) ?? "unknown",
      });
    }
  }

  async onProcessingEnd(_item: WorkItem): Promise<void> {
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

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }
}

/** Read the full request body as a string. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
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
