import { query, type Query, type SDKMessage, type SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { WebSocket } from "ws";
import { createLogger } from "../logging/logger.js";
import { ToolGuardian } from "./tool-guardian.js";
import type { ServerMessage, BeekeeperConfig } from "./types.js";

const log = createLogger("beekeeper-session");

export class SessionManager {
  private sessionId: string | null = null;
  private workspace: string;
  private activeQuery: Query | null = null;
  private client: WebSocket | null = null;
  private guardian: ToolGuardian;
  private config: BeekeeperConfig;
  private outputBuffer: ServerMessage[] = [];

  constructor(config: BeekeeperConfig, guardian: ToolGuardian) {
    this.config = config;
    this.guardian = guardian;
    this.workspace = config.defaultWorkspace;
  }

  getSessionId(): string | null {
    return this.sessionId;
  }

  getWorkspace(): string {
    return this.workspace;
  }

  setClient(ws: WebSocket | null): void {
    this.client = ws;
    // Drain buffered output to new client
    if (ws && this.outputBuffer.length > 0) {
      log.info("Draining buffered output", { count: this.outputBuffer.length });
      for (const msg of this.outputBuffer) {
        ws.send(JSON.stringify(msg));
      }
      this.outputBuffer = [];
    }
  }

  /**
   * Send a message to the client, or buffer if disconnected.
   */
  private send(msg: ServerMessage): void {
    if (this.client && this.client.readyState === 1 /* OPEN */) {
      this.client.send(JSON.stringify(msg));
    } else {
      this.outputBuffer.push(msg);
    }
  }

  /**
   * Resolve workspace name to absolute path.
   */
  private resolveWorkspace(name?: string): string {
    const wsName = name ?? this.config.defaultWorkspace;
    const path = this.config.workspaces[wsName];
    if (!path) {
      throw new Error(`Unknown workspace: ${wsName}. Available: ${Object.keys(this.config.workspaces).join(", ")}`);
    }
    return path;
  }

  /**
   * Start a new session in the given workspace.
   * Eagerly spawns the SDK session so session_info is sent immediately.
   */
  async newSession(workspaceName?: string): Promise<void> {
    // Stop existing session
    await this.stopSession();

    const wsName = workspaceName ?? this.config.defaultWorkspace;
    this.workspace = wsName;
    // Validate workspace exists
    this.resolveWorkspace(wsName);

    log.info("Starting new session", { workspace: wsName, path: this.resolveWorkspace(wsName) });

    this.sessionId = null;
    this.send({ type: "status", state: "session_ended" });

    // Eagerly spawn the session so the client gets session_info right away
    await this.runQuery("You are now connected. Briefly acknowledge readiness.");
  }

  /**
   * Send a message to the Claude Code session and stream the response.
   */
  async sendMessage(text: string): Promise<void> {
    await this.runQuery(text);
  }

  /**
   * Run a query against the SDK session and stream events to the client.
   */
  private async runQuery(text: string): Promise<void> {
    const workspacePath = this.resolveWorkspace(this.workspace);

    this.send({ type: "status", state: "thinking" });

    const guardianCallback = this.guardian.createHookCallback();

    try {
      const q = query({
        prompt: text,
        options: {
          model: this.config.model,
          permissionMode: "bypassPermissions",
          allowDangerouslySkipPermissions: true,
          includePartialMessages: true,
          cwd: workspacePath,
          ...(this.sessionId ? { resume: this.sessionId } : {}),
          hooks: {
            PreToolUse: [
              {
                hooks: [guardianCallback],
              },
            ],
          },
          env: {
            ...process.env,
            CLAUDECODE: undefined,
          },
        },
      });

      this.activeQuery = q;

      for await (const message of q) {
        const msg = message as SDKMessage;

        // Capture session ID from init
        if (msg.type === "system" && (msg as any).subtype === "init") {
          this.sessionId = (msg as any).session_id;
          this.send({
            type: "session_info",
            sessionId: this.sessionId!,
            workspace: this.workspace,
          });
        }

        // Stream text chunks
        if (msg.type === "stream_event") {
          const event = (msg as any).event;
          if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
            this.send({
              type: "message",
              text: event.delta.text,
              sessionId: this.sessionId ?? "unknown",
              final: false,
            });
          }
        }

        // Tool progress
        if (msg.type === "tool_progress") {
          this.send({ type: "status", state: "tool_running" });
        }

        // Assistant message — capture session ID
        if (msg.type === "assistant") {
          if ((msg as any).session_id) {
            this.sessionId = (msg as any).session_id;
          }
        }

        // Result message
        if (msg.type === "result") {
          const result = msg as SDKResultMessage;
          this.sessionId = result.session_id;

          if (result.subtype !== "success") {
            this.send({
              type: "error",
              message: `Session ended: ${result.subtype}`,
            });
          }

          log.info("Query complete", {
            sessionId: this.sessionId,
            cost: result.total_cost_usd,
            durationMs: result.duration_ms,
          });
        }
      }

      // Send final sentinel (streamed chunks already delivered)
      this.send({
        type: "message",
        text: "",
        sessionId: this.sessionId ?? "unknown",
        final: true,
      });
    } catch (err) {
      log.error("Query failed", { error: String(err) });
      this.send({
        type: "error",
        message: `Query failed: ${err instanceof Error ? err.message : String(err)}`,
      });
    } finally {
      this.activeQuery = null;
      this.send({ type: "status", state: "idle" });
    }
  }

  /**
   * Stop the current session.
   */
  async stopSession(): Promise<void> {
    if (this.activeQuery) {
      log.info("Stopping active query", { sessionId: this.sessionId });
      await this.activeQuery.interrupt();
      this.activeQuery = null;
    }
  }
}
