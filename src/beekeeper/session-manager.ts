import { randomUUID } from "node:crypto";
import { query, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WebSocket } from "ws";
import { createLogger } from "../logging/logger.js";
import type { ToolGuardian } from "./tool-guardian.js";
import type { ServerMessage, BeekeeperConfig } from "./types.js";

const log = createLogger("beekeeper-session");

export interface SessionSlot {
  sessionId: string;
  cwd: string;
  activeQuery: Query | null;
  state: "idle" | "busy";
  cleared?: boolean;
  /** Resolves when runQuery finishes after a clear/interrupt */
  queryDone?: Promise<string>;
  outputBuffer: ServerMessage[];
}

export class SessionManager {
  private sessions = new Map<string, SessionSlot>();
  private client: WebSocket | null = null;
  private guardian: ToolGuardian;
  private config: BeekeeperConfig;
  /** Global buffer for messages not scoped to any session (e.g. session_list) */
  private globalBuffer: ServerMessage[] = [];

  constructor(config: BeekeeperConfig, guardian: ToolGuardian) {
    this.config = config;
    this.guardian = guardian;
  }

  setClient(ws: WebSocket | null): void {
    this.client = ws;
    if (ws) {
      // Drain global buffer
      if (this.globalBuffer.length > 0) {
        log.info("Draining global buffer", { count: this.globalBuffer.length });
        for (const msg of this.globalBuffer) {
          ws.send(JSON.stringify(msg));
        }
        this.globalBuffer = [];
      }
      // Drain per-session buffers
      for (const slot of this.sessions.values()) {
        if (slot.outputBuffer.length > 0) {
          log.info("Draining session buffer", { sessionId: slot.sessionId, count: slot.outputBuffer.length });
          for (const msg of slot.outputBuffer) {
            ws.send(JSON.stringify(msg));
          }
          slot.outputBuffer = [];
        }
      }
    }
  }

  /**
   * Send a server message. Routes to the appropriate per-session buffer
   * when no client is connected, or to the global buffer for non-session messages.
   */
  send(msg: ServerMessage): void {
    if (this.client && this.client.readyState === 1) {
      this.client.send(JSON.stringify(msg));
    } else {
      // Route to per-session buffer if the message has a sessionId
      const sessionId = "sessionId" in msg ? (msg as { sessionId?: string }).sessionId : undefined;
      if (sessionId) {
        const slot = this.sessions.get(sessionId);
        if (slot) {
          slot.outputBuffer.push(msg);
          return;
        }
      }
      this.globalBuffer.push(msg);
    }
  }

  /**
   * Create a new session in the given cwd. Spawns SDK eagerly.
   */
  async newSession(cwd: string): Promise<string> {
    log.info("Creating new session", { cwd });
    const pendingId = `pending-${randomUUID()}`;
    const slot: SessionSlot = {
      sessionId: pendingId,
      cwd,
      activeQuery: null,
      state: "idle",
      outputBuffer: [],
    };

    // Register immediately so the session is visible during the inaugural query
    this.sessions.set(pendingId, slot);

    const realId = await this.runQuery(slot, "You are now connected. Briefly acknowledge readiness.");

    // Replace pending key with real session ID
    this.sessions.delete(pendingId);
    slot.sessionId = realId;
    this.sessions.set(realId, slot);
    log.info("Session created", { sessionId: realId, cwd });
    return realId;
  }

  /**
   * Send a message to a specific session.
   */
  async sendMessage(sessionId: string, text: string): Promise<void> {
    const slot = this.sessions.get(sessionId);
    if (!slot) {
      this.send({ type: "error", message: `Unknown session: ${sessionId}`, sessionId });
      return;
    }
    if (slot.state === "busy") {
      this.send({ type: "error", message: "Session is busy", sessionId });
      return;
    }
    const done = this.runQuery(slot, text);
    slot.queryDone = done;
    await done;
  }

  /**
   * Clear (stop and remove) a specific session.
   */
  async clearSession(sessionId: string): Promise<boolean> {
    const slot = this.sessions.get(sessionId);
    if (!slot) return false;

    slot.cleared = true;
    if (slot.activeQuery) {
      try {
        await slot.activeQuery.interrupt();
      } catch (err) {
        log.error("Failed to interrupt session during clear", { sessionId, error: String(err) });
      }
      // Wait for runQuery to fully finish before removing from map
      if (slot.queryDone) {
        try {
          await slot.queryDone;
        } catch {
          // Already handled inside runQuery
        }
      }
    }
    this.send({ type: "session_cleared", sessionId });
    this.sessions.delete(sessionId);
    log.info("Session cleared", { sessionId });
    return true;
  }

  /**
   * List all active sessions.
   */
  listSessions(): void {
    const sessions = Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      path: s.cwd,
      state: s.state,
    }));
    this.send({ type: "session_list", sessions });
  }

  /**
   * Get session info for reconnection.
   */
  getActiveSessions(): Array<{ sessionId: string; path: string; state: "idle" | "busy" }> {
    return Array.from(this.sessions.values()).map((s) => ({
      sessionId: s.sessionId,
      path: s.cwd,
      state: s.state,
    }));
  }

  /**
   * Stop all sessions (used on shutdown).
   */
  async stopAll(): Promise<void> {
    for (const [sessionId, slot] of this.sessions) {
      if (slot.activeQuery) {
        try {
          log.info("Stopping session", { sessionId });
          await slot.activeQuery.interrupt();
        } catch (err) {
          log.error("Failed to stop session", { sessionId, error: String(err) });
        }
      }
    }
    this.sessions.clear();
  }

  /**
   * Run a query in a session slot.
   */
  private async runQuery(slot: SessionSlot, text: string): Promise<string> {
    slot.state = "busy";
    this.send({ type: "status", state: "thinking", sessionId: slot.sessionId });

    const guardianCallback = this.guardian.createHookCallback(slot.sessionId);

    try {
      const q = query({
        prompt: text,
        options: {
          model: this.config.model,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          cwd: slot.cwd,
          plugins: this.config.plugins?.map((p) => ({ type: "local" as const, path: p })),
          ...(slot.sessionId.startsWith("pending-") ? {} : { resume: slot.sessionId }),
          hooks: {
            PreToolUse: [
              {
                hooks: [guardianCallback],
              },
            ],
          },
          env: this.cleanEnv(),
        },
      });

      slot.activeQuery = q;
      let resolvedSessionId = slot.sessionId;

      for await (const message of q) {
        const msg = message as SDKMessage;

        if (msg.type === "system" && (msg as any).subtype === "init") {
          resolvedSessionId = (msg as any).session_id;
          slot.sessionId = resolvedSessionId;
          this.send({
            type: "session_info",
            sessionId: resolvedSessionId,
            path: slot.cwd,
          });
        }

        if (msg.type === "stream_event") {
          const event = (msg as any).event;
          if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
            this.send({
              type: "message",
              text: event.delta.text,
              sessionId: resolvedSessionId,
              final: false,
            });
          }
        }

        if (msg.type === "tool_progress") {
          this.send({ type: "status", state: "tool_running", sessionId: resolvedSessionId });
        }

        if (msg.type === "assistant") {
          if ((msg as any).session_id) {
            resolvedSessionId = (msg as any).session_id;
            slot.sessionId = resolvedSessionId;
          }
        }

        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          resolvedSessionId = result.session_id;
          slot.sessionId = resolvedSessionId;

          if (result.subtype !== "success") {
            this.send({
              type: "error",
              message: `Session ended: ${result.subtype}`,
              sessionId: resolvedSessionId,
            });
          }

          log.info("Query complete", {
            sessionId: resolvedSessionId,
            cost: result.total_cost_usd,
            durationMs: result.duration_ms,
          });
        }
      }

      this.send({
        type: "message",
        text: "",
        sessionId: resolvedSessionId,
        final: true,
      });

      return resolvedSessionId;
    } catch (err) {
      log.error("Query failed", { sessionId: slot.sessionId, error: String(err) });
      this.send({
        type: "error",
        message: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
        sessionId: slot.sessionId,
      });
      return slot.sessionId;
    } finally {
      slot.activeQuery = null;
      slot.state = "idle";
      // Suppress status messages for cleared sessions — session_cleared is the terminal event
      if (!slot.cleared) {
        this.send({ type: "status", state: "idle", sessionId: slot.sessionId });
      }
    }
  }

  private cleanEnv(): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (key === "CLAUDECODE") continue;
      if (key === "ANTHROPIC_API_KEY" && !value) continue;
      if (value !== undefined) env[key] = value;
    }
    return env;
  }
}
