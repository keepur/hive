import "dotenv/config";
import { createServer, type IncomingMessage } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "node:url";
import { timingSafeEqual } from "node:crypto";
import { createLogger } from "../logging/logger.js";
import { loadConfig } from "./config.js";
import { ToolGuardian } from "./tool-guardian.js";
import { QuestionRelayer } from "./question-relayer.js";
import { SessionManager } from "./session-manager.js";
import { BeekeeperDeviceRegistry, type BeekeeperDevice } from "./device-registry.js";
import { validatePath } from "./path-utils.js";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { ClientMessage, ServerMessage } from "./types.js";

const log = createLogger("beekeeper");

async function main(): Promise<void> {
  const config = loadConfig();
  const guardian = new ToolGuardian(config.confirmOperations);
  const questionRelayer = new QuestionRelayer();
  const sessionManager = new SessionManager(config, guardian, questionRelayer);
  sessionManager.restoreSessions();

  // Connect device registry (fail to start if MongoDB unreachable)
  const deviceRegistry = new BeekeeperDeviceRegistry(config.mongoUri, config.mongoDbName, config.jwtSecret);
  await deviceRegistry.connect();

  // Track connected devices (multiple clients allowed)
  const connectedClients = new Map<string, WebSocket>();

  // Set guardian delegate once — SessionManager handles broadcast/buffering
  guardian.setSendDelegate((msg) => sessionManager.send(msg));
  questionRelayer.setSendDelegate((msg) => sessionManager.send(msg));

  // --- Helper functions ---

  function verifyAdmin(req: IncomingMessage): boolean {
    const auth = req.headers.authorization;
    if (!auth || !auth.startsWith("Bearer ")) return false;
    const provided = Buffer.from(auth.slice(7));
    const expected = Buffer.from(config.adminSecret);
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(provided, expected);
  }

  async function verifyDeviceToken(req: IncomingMessage): Promise<BeekeeperDevice | null> {
    const auth = req.headers.authorization;
    const token = auth?.startsWith("Bearer ") ? auth.slice(7) : null;
    if (!token) return null;
    return deviceRegistry.verifyToken(token);
  }

  // --- HTTP server ---

  const server = createServer(async (req, res) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, PUT, DELETE, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${config.port}`);

    // GET /health (public)
    if (req.method === "GET" && url.pathname === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          sessions: sessionManager.getActiveSessions().length,
          connectedDevices: connectedClients.size,
        }),
      );
      return;
    }

    // POST /pair (public) — exchange pairing code for JWT
    if (req.method === "POST" && url.pathname === "/pair") {
      try {
        const body = await readBody(req);
        let parsed: { code?: string; name?: string };
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

        const name = typeof parsed.name === "string" ? parsed.name.trim() : undefined;
        const result = await deviceRegistry.verifyPairingCode(parsed.code, name || undefined);
        if (!result) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid or expired pairing code" }));
          return;
        }

        log.info("Device paired via HTTP", { deviceId: result.device._id });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            token: result.token,
            deviceId: result.device._id,
            deviceName: result.device.name,
          }),
        );
      } catch (err) {
        log.error("Pair endpoint error", { error: String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    // --- Device self-service (Bearer JWT) ---

    // GET /me
    if (req.method === "GET" && url.pathname === "/me") {
      try {
        const device = await verifyDeviceToken(req);
        if (!device) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deviceId: device._id, name: device.name }));
      } catch (err) {
        log.error("GET /me error", { error: String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    // PUT /me
    if (req.method === "PUT" && url.pathname === "/me") {
      try {
        const device = await verifyDeviceToken(req);
        if (!device) {
          res.writeHead(401, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unauthorized" }));
          return;
        }
        const body = await readBody(req);
        let parsed: { name?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
        if (!name) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Missing required field: name" }));
          return;
        }
        const updated = await deviceRegistry.updateDevice(device._id, { name });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ deviceId: device._id, name: updated?.name ?? name }));
      } catch (err) {
        log.error("PUT /me error", { error: String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    // --- Admin API (Bearer BEEKEEPER_ADMIN_SECRET) ---
    const isAdmin = verifyAdmin(req);

    // POST /devices
    if (req.method === "POST" && url.pathname === "/devices") {
      if (!isAdmin) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      try {
        const body = await readBody(req);
        let parsed: { name?: string };
        try {
          parsed = JSON.parse(body);
        } catch {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Invalid JSON" }));
          return;
        }
        const name = parsed.name || "Unnamed Device";
        const device = await deviceRegistry.createDevice(name);
        res.writeHead(201, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            deviceId: device._id,
            name: device.name,
            pairingCode: device.pairingCode,
            expiresAt: device.pairingCodeExpiresAt,
          }),
        );
      } catch (err) {
        log.error("Create device error", { error: String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    // GET /devices
    if (req.method === "GET" && url.pathname === "/devices") {
      if (!isAdmin) {
        res.writeHead(401);
        res.end("Unauthorized");
        return;
      }
      try {
        const devices = await deviceRegistry.listDevices();
        const list = devices.map((d) => ({
          deviceId: d._id,
          name: d.name,
          active: d.active,
          paired: !!d.pairedAt,
          pairedAt: d.pairedAt,
          lastSeenAt: d.lastSeenAt,
          connected: connectedClients.has(d._id),
          hasPendingCode: !!d.pairingCode,
        }));
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(list));
      } catch (err) {
        log.error("List devices error", { error: String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
      return;
    }

    // Routes with device ID: /devices/:id/...
    const deviceMatch = url.pathname.match(/^\/devices\/([^/]+)(\/(.+))?$/);
    if (deviceMatch && isAdmin) {
      const deviceId = deviceMatch[1];
      const action = deviceMatch[3];

      // GET /devices/:id
      if (req.method === "GET" && !action) {
        try {
          const device = await deviceRegistry.getDevice(deviceId);
          if (!device) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Device not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              deviceId: device._id,
              name: device.name,
              active: device.active,
              paired: !!device.pairedAt,
              pairedAt: device.pairedAt,
              lastSeenAt: device.lastSeenAt,
              connected: connectedClients.has(device._id),
              hasPendingCode: !!device.pairingCode,
            }),
          );
        } catch (err) {
          log.error("Get device error", { error: String(err) });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
        return;
      }

      // PUT /devices/:id
      if (req.method === "PUT" && !action) {
        try {
          const body = await readBody(req);
          let parsed: { name?: string };
          try {
            parsed = JSON.parse(body);
          } catch {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Invalid JSON" }));
            return;
          }
          if (!parsed.name) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "No fields to update" }));
            return;
          }
          const device = await deviceRegistry.updateDevice(deviceId, { name: parsed.name });
          if (!device) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Device not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ deviceId: device._id, name: device.name }));
        } catch (err) {
          log.error("Update device error", { error: String(err) });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
        return;
      }

      // DELETE /devices/:id
      if (req.method === "DELETE" && !action) {
        try {
          const ok = await deviceRegistry.deactivateDevice(deviceId);
          if (!ok) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Device not found or already inactive" }));
            return;
          }
          // Force-disconnect if this device is connected
          const deviceWs = connectedClients.get(deviceId);
          if (deviceWs) {
            deviceWs.close(1000, "Device deactivated");
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          log.error("Deactivate device error", { error: String(err) });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
        return;
      }

      // POST /devices/:id/refresh-code
      if (req.method === "POST" && action === "refresh-code") {
        try {
          const code = await deviceRegistry.refreshPairingCode(deviceId);
          if (!code) {
            res.writeHead(404, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "Device not found" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ pairingCode: code }));
        } catch (err) {
          log.error("Refresh code error", { error: String(err) });
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
        return;
      }
    } else if (deviceMatch && !isAdmin) {
      res.writeHead(401);
      res.end("Unauthorized");
      return;
    }

    res.writeHead(404);
    res.end();
  });

  // --- WebSocket server with JWT auth on upgrade ---
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", async (req, socket, head) => {
    try {
      const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
      const token = url.searchParams.get("token") ?? req.headers.authorization?.replace("Bearer ", "");

      if (!token) {
        log.warn("WebSocket auth failed — no token");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      const device = await deviceRegistry.verifyToken(token);
      if (!device) {
        log.warn("WebSocket auth failed — invalid token");
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }

      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, device);
      });
    } catch (err) {
      log.error("WebSocket upgrade error", { error: String(err) });
      socket.write("HTTP/1.1 500 Internal Server Error\r\n\r\n");
      socket.destroy();
    }
  });

  // --- Multi-client connection management ---

  wss.on("connection", (ws: WebSocket, device: BeekeeperDevice) => {
    log.info("Client connected", { deviceId: device._id, name: device.name, totalClients: connectedClients.size + 1 });

    connectedClients.set(device._id, ws);
    sessionManager.addClient(device._id, ws);

    // Update lastSeenAt
    deviceRegistry
      .updateLastSeen(device._id)
      .catch((err) => log.warn("Failed to update lastSeenAt", { error: String(err) }));

    // Send session list to this device on connect
    const activeSessions = sessionManager.getActiveSessions();
    if (activeSessions.length > 0) {
      const msg: ServerMessage = { type: "session_list", sessions: activeSessions };
      ws.send(JSON.stringify(msg));
    }

    ws.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(raw.toString()) as ClientMessage;
      } catch {
        ws.send(JSON.stringify({ type: "error", message: "Invalid JSON" }));
        return;
      }

      log.info("WS message received", { type: msg.type, raw: raw.toString().slice(0, 200) });

      try {
        switch (msg.type) {
          case "ping":
            deviceRegistry
              .updateLastSeen(device._id)
              .catch((err) => log.warn("Failed to update lastSeenAt", { error: String(err) }));
            ws.send(JSON.stringify({ type: "pong" }));
            break;
          case "message":
            await sessionManager.sendMessage(msg.sessionId, msg.text);
            break;
          case "new_session": {
            if (!msg.path || typeof msg.path !== "string") {
              ws.send(JSON.stringify({ type: "error", message: "Missing required field: path" }));
              break;
            }
            try {
              const validatedPath = validatePath(msg.path);
              await sessionManager.newSession(validatedPath);
            } catch (err) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            }
            break;
          }
          case "clear_session":
            await sessionManager.clearSession(msg.sessionId);
            break;
          case "cancel":
            await sessionManager.cancelQuery(msg.sessionId);
            break;
          case "list_sessions":
            sessionManager.listSessions();
            break;
          case "browse": {
            try {
              const home = realpathSync(homedir());
              const browseTarget = msg.path ? validatePath(msg.path) : home;
              const dirEntries = readdirSync(browseTarget, { withFileTypes: true });
              const entries = dirEntries
                .filter((e) => !e.name.startsWith("."))
                .map((e) => {
                  let isDirectory = e.isDirectory();
                  if (e.isSymbolicLink()) {
                    try {
                      isDirectory = statSync(join(browseTarget, e.name)).isDirectory();
                    } catch {
                      /* broken symlink — treat as file */
                    }
                  }
                  return { name: e.name, isDirectory };
                })
                .sort((a, b) => {
                  if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
                  return a.name.localeCompare(b.name);
                })
                .slice(0, 200);
              ws.send(JSON.stringify({ type: "browse_result", path: browseTarget, entries }));
            } catch (err) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            }
            break;
          }
          case "list_workspace_sessions": {
            if (!msg.path || typeof msg.path !== "string") {
              ws.send(JSON.stringify({ type: "error", message: "Missing required field: path" }));
              break;
            }
            try {
              const validatedPath = validatePath(msg.path);
              await sessionManager.listWorkspaceSessions(validatedPath);
            } catch (err) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            }
            break;
          }
          case "resume_session": {
            if (!msg.sessionId || !msg.path) {
              ws.send(JSON.stringify({ type: "error", message: "Missing required fields: sessionId, path" }));
              break;
            }
            const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
            if (!UUID_RE.test(msg.sessionId)) {
              ws.send(JSON.stringify({ type: "error", message: "Invalid sessionId format" }));
              break;
            }
            try {
              const validatedPath = validatePath(msg.path);
              sessionManager.resumeSession(msg.sessionId, validatedPath);
            } catch (err) {
              ws.send(
                JSON.stringify({
                  type: "error",
                  message: err instanceof Error ? err.message : String(err),
                }),
              );
            }
            break;
          }
          case "approve":
            guardian.handleApproval(msg.toolUseId, true);
            break;
          case "deny":
            guardian.handleApproval(msg.toolUseId, false);
            break;
          default:
            ws.send(JSON.stringify({ type: "error", message: "Unknown message type" }));
        }
      } catch (err) {
        log.error("Error handling message", { type: msg.type, error: String(err) });
        ws.send(
          JSON.stringify({
            type: "error",
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      }
    });

    ws.on("close", () => {
      // Guard: only remove if this specific ws is still the registered client.
      // A stale close from an old socket must not evict a newer connection.
      if (connectedClients.get(device._id) === ws) {
        connectedClients.delete(device._id);
        sessionManager.removeClient(device._id);
      }
      log.info("Client disconnected", { deviceId: device._id, remainingClients: connectedClients.size });
      // If no clients remain, deny all pending questions — no one can answer them
      if (connectedClients.size === 0) {
        questionRelayer.denyAll("All clients disconnected");
      }
      // Sessions stay in memory — any device can reconnect and resume
    });

    ws.on("error", (err) => {
      log.error("WebSocket error", { error: String(err) });
    });
  });

  // --- Start ---
  server.listen(config.port, () => {
    log.info("Beekeeper is running", { port: config.port });
  });

  // --- Graceful shutdown ---
  const shutdown = async () => {
    log.info("Shutting down");
    sessionManager.persistSessions();
    questionRelayer.denyAll("Server shutting down");
    await sessionManager.stopAll();
    wss.close();
    server.close();
    await deviceRegistry.close();
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

const MAX_BODY_BYTES = 16_384; // 16 KB

/** Read the full request body as a string. Rejects if body exceeds size cap. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    req.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error("Request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

main().catch((err) => {
  log.error("Failed to start beekeeper", { error: String(err) });
  process.exit(1);
});
