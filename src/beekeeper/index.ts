import "dotenv/config";
import { createServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { URL } from "node:url";
import { createLogger } from "../logging/logger.js";
import { loadConfig } from "./config.js";
import { ToolGuardian } from "./tool-guardian.js";
import { SessionManager } from "./session-manager.js";
import type { ClientMessage, ServerMessage } from "./types.js";

const log = createLogger("beekeeper");

const config = loadConfig();
const guardian = new ToolGuardian(config.confirmOperations);
const sessionManager = new SessionManager(config, guardian);

// HTTP server for health check
const server = createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: "ok",
        sessionId: sessionManager.getSessionId(),
        workspace: sessionManager.getWorkspace(),
      }),
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

// WebSocket server with auth on upgrade
const wss = new WebSocketServer({ noServer: true });

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`);
  const token = url.searchParams.get("token") ?? req.headers.authorization?.replace("Bearer ", "");

  if (token !== config.authToken) {
    log.warn("WebSocket auth failed");
    socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws);
  });
});

// Single client connection management
let activeClient: WebSocket | null = null;

wss.on("connection", (ws: WebSocket) => {
  log.info("Client connected");

  // Replace previous client if any
  if (activeClient && activeClient.readyState === WebSocket.OPEN) {
    log.info("Replacing existing client connection");
    guardian.denyAll("Replaced by new connection");
    activeClient.close(1000, "Replaced by new connection");
  }

  activeClient = ws;
  guardian.setClient(ws);
  sessionManager.setClient(ws);

  // Send current session info or start new session
  const sessionId = sessionManager.getSessionId();
  if (sessionId) {
    const msg: ServerMessage = {
      type: "session_info",
      sessionId,
      workspace: sessionManager.getWorkspace(),
      workspaces: Object.keys(config.workspaces),
    };
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

    try {
      switch (msg.type) {
        case "ping":
          ws.send(JSON.stringify({ type: "pong" }));
          break;

        case "message":
          await sessionManager.sendMessage(msg.text);
          break;

        case "new_session":
          await sessionManager.newSession(msg.workspace);
          break;

        case "switch_workspace":
          await sessionManager.newSession(msg.workspace);
          break;

        case "approve":
          guardian.handleApproval(msg.toolUseId, true);
          break;

        case "deny":
          guardian.handleApproval(msg.toolUseId, false);
          break;

        default:
          ws.send(JSON.stringify({ type: "error", message: `Unknown message type` }));
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
    log.info("Client disconnected");
    if (activeClient === ws) {
      activeClient = null;
      guardian.setClient(null);
      sessionManager.setClient(null);
    }
  });

  ws.on("error", (err) => {
    log.error("WebSocket error", { error: String(err) });
  });
});

// Start server
server.listen(config.port, () => {
  log.info("Beekeeper is running", { port: config.port });
});

// Graceful shutdown
process.on("SIGTERM", () => {
  log.info("Shutting down");
  wss.close();
  server.close();
  process.exit(0);
});

process.on("SIGINT", () => {
  log.info("Shutting down");
  wss.close();
  server.close();
  process.exit(0);
});
