import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { query, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WebSocket } from "ws";
import { createLogger } from "../logging/logger.js";
import type { ToolGuardian } from "./tool-guardian.js";
import type { QuestionRelayer } from "./question-relayer.js";
import type { ServerMessage, BeekeeperConfig } from "./types.js";
import { listWorkspaceSessions as scanWorkspaceSessions } from "./session-history.js";

const log = createLogger("beekeeper-session");

export interface SessionSlot {
  sessionId: string;
  cwd: string;
  activeQuery: Query | null;
  state: "idle" | "busy";
  cleared?: boolean;
  clearing?: boolean;
  interrupted?: boolean;
  /** Resolves when runQuery finishes after a clear/interrupt */
  queryDone?: Promise<string>;
  outputBuffer: ServerMessage[];
}

interface CommandDef {
  description: string;
  handler: (sessionId: string, args: string[], slot: SessionSlot) => Promise<void>;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

interface RunQueryOptions {
  /**
   * When true, suppress the initial `status(thinking)` emit and the
   * `session_info` emit on SDK init. Used by /clear to avoid leaking
   * intermediate new-session signals to the client before session_replaced.
   */
  suppressClientSignals?: boolean;
  /**
   * Called synchronously when the SDK's `system/init` message arrives,
   * carrying the real session_id. Used by newSession() to return early.
   */
  onInit?: (realSessionId: string) => void;
}

export class SessionManager {
  private sessions = new Map<string, SessionSlot>();
  private clients = new Map<string, WebSocket>();
  private guardian: ToolGuardian;
  private questionRelayer: QuestionRelayer;
  private config: BeekeeperConfig;
  private sessionsFile: string;
  /** Global buffer for messages sent when no clients are connected */
  private globalBuffer: ServerMessage[] = [];
  private commands = new Map<string, CommandDef>();

  constructor(config: BeekeeperConfig, guardian: ToolGuardian, questionRelayer: QuestionRelayer) {
    this.config = config;
    this.guardian = guardian;
    this.questionRelayer = questionRelayer;
    this.sessionsFile = join(config.dataDir, "sessions.json");

    // Register slash commands
    this.commands.set("clear", {
      description: "Reset context and start a fresh session",
      handler: (sessionId, _args, slot) => this.handleClear(sessionId, slot),
    });
    this.commands.set("help", {
      description: "Show available commands",
      handler: (sessionId) => this.handleHelp(sessionId),
    });
    this.commands.set("status", {
      description: "Show current session info",
      handler: (sessionId, _args, slot) => this.handleStatus(sessionId, slot),
    });
  }

  addClient(deviceId: string, ws: WebSocket): void {
    this.clients.set(deviceId, ws);
    // Drain global buffer to new client
    if (this.globalBuffer.length > 0) {
      log.info("Draining global buffer", { deviceId, count: this.globalBuffer.length });
      for (const msg of this.globalBuffer) {
        ws.send(JSON.stringify(msg));
      }
      this.globalBuffer = [];
    }
    // Drain per-session buffers to new client
    for (const slot of this.sessions.values()) {
      if (slot.outputBuffer.length > 0) {
        log.info("Draining session buffer", { deviceId, sessionId: slot.sessionId, count: slot.outputBuffer.length });
        for (const msg of slot.outputBuffer) {
          ws.send(JSON.stringify(msg));
        }
        slot.outputBuffer = [];
      }
    }
  }

  removeClient(deviceId: string): void {
    this.clients.delete(deviceId);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  /**
   * Broadcast a server message to all connected clients.
   * Buffers messages when no clients are connected.
   */
  send(msg: ServerMessage): void {
    const payload = JSON.stringify(msg);
    let sent = false;
    for (const ws of this.clients.values()) {
      if (ws.readyState === 1) {
        ws.send(payload);
        sent = true;
      }
    }
    if (!sent) {
      // No connected clients — buffer the message
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
   * Create a new session in the given cwd. Spawns SDK and returns as soon as
   * the `system/init` event fires (carrying the real session_id). The welcome
   * query continues streaming in the background.
   *
   * When called from /clear, pass `suppressClientSignals: true` so the
   * bootstrap query does not leak `status(thinking)` or `session_info` to the
   * client before handleClear can emit session_replaced.
   */
  async newSession(cwd: string, opts?: { suppressClientSignals?: boolean }): Promise<string> {
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

    const initDeferred = createDeferred<string>();
    let initFired = false;

    const donePromise = this.runQuery(slot, "You are now connected. Briefly acknowledge readiness.", {
      suppressClientSignals: opts?.suppressClientSignals,
      onInit: (realId) => {
        initFired = true;
        initDeferred.resolve(realId);
      },
    });

    // If runQuery settles without init ever firing, reject the init deferred
    // so newSession() doesn't hang forever. Covers both:
    //   - SDK throws/errors before init (donePromise rejects)
    //   - SDK returns a `result` before emitting `system/init` (donePromise resolves)
    donePromise.finally(() => {
      if (!initFired) {
        initDeferred.reject(new Error("Session never initialized (SDK completed without init event)"));
      }
    });
    // Swallow any unhandled rejection on donePromise itself. runQuery has a
    // top-level try/catch that normally converts errors to error-message sends
    // and a normal return, so this is defensive. In the init-never-fires path
    // the caller awaits initDeferred.promise (which we rejected above), and
    // nothing else awaits donePromise in that path — avoid the unhandled
    // rejection warning.
    donePromise.catch(() => {});

    slot.queryDone = donePromise;

    const realId = await initDeferred.promise;

    // Swap the map key from pending to real. Welcome stream continues in the
    // background and now routes via this slot's outputBuffer when offline.
    this.sessions.delete(pendingId);
    slot.sessionId = realId;
    this.sessions.set(realId, slot);
    this.persistSessions();
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

    // Slash command detection — runs BEFORE busy check
    if (text.startsWith("/")) {
      const parts = text.trimEnd().split(/\s+/);
      const name = parts[0].slice(1).toLowerCase();
      const cmd = this.commands.get(name);
      if (cmd) {
        log.info("Executing slash command", { sessionId, command: name });
        await cmd.handler(sessionId, parts.slice(1), slot);
        return;
      }
      // Unknown command — fall through to SDK as normal text
    }

    if (slot.state === "busy") {
      this.send({ type: "status", state: "busy", sessionId });
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
    this.persistSessions();
    log.info("Session cleared", { sessionId });
    return true;
  }

  /**
   * Cancel (interrupt without destroying) a specific session's active query.
   */
  async cancelQuery(sessionId: string): Promise<void> {
    const slot = this.sessions.get(sessionId);
    if (!slot || !slot.activeQuery) return;

    // Set interrupted flag BEFORE interrupt to suppress spurious empty final message
    slot.interrupted = true;

    // Then interrupt the SDK query
    try {
      await slot.activeQuery.interrupt();
    } catch (err) {
      log.error("Failed to interrupt session during cancel", { sessionId, error: String(err) });
    }
    // State transition handled by runQuery's finally block
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
   * Resume a past session by ID. Lazy — no SDK call until user sends a message.
   * If the session is already active, returns the existing session info.
   */
  resumeSession(sessionId: string, cwd: string): string {
    // Already active — just return it
    const existing = this.sessions.get(sessionId);
    if (existing) {
      log.info("Session already active, returning existing", { sessionId });
      this.send({ type: "session_info", sessionId, path: existing.cwd });
      return sessionId;
    }

    const slot: SessionSlot = {
      sessionId,
      cwd,
      activeQuery: null,
      state: "idle",
      outputBuffer: [],
    };
    this.sessions.set(sessionId, slot);
    this.persistSessions();
    this.send({ type: "session_info", sessionId, path: cwd });
    log.info("Session resumed (lazy)", { sessionId, cwd });
    return sessionId;
  }

  /**
   * List historical sessions for a workspace from ~/.claude/projects/.
   */
  async listWorkspaceSessions(path: string): Promise<void> {
    const activeIds = new Set(this.sessions.keys());
    const sessions = await scanWorkspaceSessions(path, activeIds);
    this.send({ type: "workspace_session_list", path, sessions });
  }

  /**
   * Persist session map to disk so sessions survive server restarts.
   * Only saves sessionId and cwd — everything else is reconstructed lazily.
   */
  persistSessions(): void {
    try {
      const dir = dirname(this.sessionsFile);
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      const data = Array.from(this.sessions.values())
        .filter((s) => !s.sessionId.startsWith("pending-"))
        .map((s) => ({ sessionId: s.sessionId, cwd: s.cwd }));
      const tmpFile = this.sessionsFile + ".tmp";
      writeFileSync(tmpFile, JSON.stringify(data, null, 2));
      renameSync(tmpFile, this.sessionsFile);
      log.info("Persisted sessions", { count: data.length, path: this.sessionsFile });
    } catch (err) {
      log.error("Failed to persist sessions", { error: String(err) });
    }
  }

  /**
   * Restore sessions from disk after server restart.
   * Registers each as a lazy session (no SDK call until a message is sent).
   */
  restoreSessions(): void {
    if (!existsSync(this.sessionsFile)) {
      log.info("No sessions file to restore", { path: this.sessionsFile });
      return;
    }
    try {
      const raw = readFileSync(this.sessionsFile, "utf-8");
      if (!raw.trim()) {
        log.info("Sessions file is empty, starting fresh");
        return;
      }
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        log.error("sessions.json is not an array, skipping restore");
        return;
      }
      let restored = 0;
      for (const entry of parsed) {
        if (typeof entry?.sessionId !== "string" || typeof entry?.cwd !== "string") {
          log.warn("Skipping invalid session entry", { entry });
          continue;
        }
        if (this.sessions.has(entry.sessionId)) continue;
        // Register slot directly — no persist or broadcast needed during restore
        const slot: SessionSlot = {
          sessionId: entry.sessionId,
          cwd: entry.cwd,
          activeQuery: null,
          state: "idle",
          outputBuffer: [],
        };
        this.sessions.set(entry.sessionId, slot);
        restored++;
      }
      log.info("Restored sessions from disk", { count: restored, total: parsed.length });
    } catch (err) {
      log.error("Failed to restore sessions", { error: String(err) });
    }
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
   * /help — list available slash commands.
   */
  private async handleHelp(sessionId: string): Promise<void> {
    const lines = ["Available commands:"];
    for (const [name, def] of this.commands) {
      lines.push(`  /${name}  — ${def.description}`);
    }
    this.send({ type: "message", text: lines.join("\n"), sessionId, final: true });
  }

  /**
   * /status — show session metadata.
   */
  private async handleStatus(sessionId: string, slot: SessionSlot): Promise<void> {
    const lines = [`Session: ${slot.sessionId}`, `Workspace: ${slot.cwd}`, `State: ${slot.state}`];
    this.send({ type: "message", text: lines.join("\n"), sessionId, final: true });
  }

  /**
   * /clear — destroy the current session and create a fresh one, then emit
   * a single atomic session_replaced message so the client can swap sessions
   * without ambiguity.
   *
   * Flow:
   * 1. Tear down old session inline (interrupt if busy, await, remove from map)
   * 2. Create fresh session with suppressClientSignals so no intermediate
   *    status/session_info reaches the client before session_replaced
   * 3. Emit session_replaced { oldSessionId, newSessionId, path }
   * 4. Welcome stream continues in the background and lands on the client
   *    naturally under the new sessionId
   *
   * On newSession() failure (including the init-never-fires case), emit an
   * error and do NOT emit session_replaced. Client stays in its loading state
   * and the user can retry manually.
   *
   * Guarded by slot.clearing to prevent concurrent /clear calls from
   * creating duplicate sessions.
   */
  private async handleClear(sessionId: string, slot: SessionSlot): Promise<void> {
    // Guard against concurrent /clear calls on the same session
    if (slot.clearing) return;
    slot.clearing = true;

    const cwd = slot.cwd;
    const oldSessionId = sessionId;

    // 1. Tear down old session inline
    slot.cleared = true;
    if (slot.activeQuery) {
      try {
        await slot.activeQuery.interrupt();
      } catch (err) {
        log.error("Failed to interrupt session during /clear", { sessionId, error: String(err) });
      }
    }
    // Await queryDone independently — activeQuery is nulled in runQuery's finally
    // block before queryDone resolves, so the guard must be separate to avoid a race.
    if (slot.queryDone) {
      try {
        await slot.queryDone;
      } catch {
        // Already handled inside runQuery
      }
    }
    this.sessions.delete(sessionId);
    this.persistSessions();
    log.info("Session torn down for /clear", { sessionId });

    // 2. Create fresh session with client signals suppressed so nothing about
    //    the new session reaches the client before session_replaced.
    let newSessionId: string;
    try {
      newSessionId = await this.newSession(cwd, { suppressClientSignals: true });
    } catch (err) {
      log.error("Failed to create new session after /clear", { cwd, error: String(err) });
      this.send({
        type: "error",
        message: `Context cleared but failed to start new session: ${err instanceof Error ? err.message : String(err)}`,
      });
      return;
    }

    // 3. Emit the atomic swap signal. The welcome stream continues in the
    //    background and lands under newSessionId, which the client has now
    //    adopted.
    this.send({
      type: "session_replaced",
      oldSessionId,
      newSessionId,
      path: cwd,
    });
  }

  /**
   * Run a query in a session slot.
   */
  private async runQuery(slot: SessionSlot, text: string, opts?: RunQueryOptions): Promise<string> {
    slot.state = "busy";
    if (!opts?.suppressClientSignals) {
      this.send({ type: "status", state: "thinking", sessionId: slot.sessionId });
    }

    const guardianCallback = this.guardian.createHookCallback(slot.sessionId);
    const questionCallback = this.questionRelayer.createHookCallback(slot.sessionId);

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
              {
                hooks: [questionCallback],
              },
            ],
          },
          env: this.cleanEnv(),
        },
      });

      slot.activeQuery = q;
      let resolvedSessionId = slot.sessionId;
      const toolNames = new Map<string, string>();

      for await (const message of q) {
        const msg = message as SDKMessage;

        if (msg.type === "system" && (msg as any).subtype === "init") {
          resolvedSessionId = (msg as any).session_id;
          slot.sessionId = resolvedSessionId;
          if (!opts?.suppressClientSignals) {
            this.send({
              type: "session_info",
              sessionId: resolvedSessionId,
              path: slot.cwd,
            });
          }
          opts?.onInit?.(resolvedSessionId);
        }

        if (msg.type === "stream_event") {
          const event = (msg as any).event;
          if (event?.type === "content_block_start") {
            const block = event.content_block;
            if (block?.type === "thinking") {
              this.send({ type: "status", state: "thinking", sessionId: resolvedSessionId });
            } else if (block?.type === "tool_use" && typeof block.name === "string") {
              toolNames.set(block.id, block.name);
              this.send({
                type: "status",
                state: "tool_starting",
                sessionId: resolvedSessionId,
                toolName: block.name,
              });
            }
          }
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
          const tp = msg as any;
          const toolName = typeof tp.tool_name === "string" ? tp.tool_name : undefined;
          if (toolName && typeof tp.tool_use_id === "string") {
            toolNames.set(tp.tool_use_id, toolName);
          }
          this.send({
            type: "status",
            state: "tool_running",
            sessionId: resolvedSessionId,
            toolName,
          });
        }

        if (msg.type === "assistant") {
          if ((msg as any).session_id) {
            resolvedSessionId = (msg as any).session_id;
            slot.sessionId = resolvedSessionId;
          }
        }

        // Skip tool_output relay — status messages (tool_starting/tool_running)
        // already show what's happening, and raw tool output is too verbose for the client.

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

      // Suppress empty final message after interrupt — prevents empty bubble on client
      if (!slot.interrupted) {
        this.send({
          type: "message",
          text: "",
          sessionId: resolvedSessionId,
          final: true,
        });
      }

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
      slot.interrupted = false;
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
