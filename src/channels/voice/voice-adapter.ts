import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logging/logger.js";
import { buildVoiceSystemPrompt } from "../../agents/prompt-builder.js";
import {
  openaiToClaude,
  openaiToolsToClaude,
  formatSSETextChunk,
  formatSSEDone,
  formatNonStreamingResponse,
  type OpenAIChatRequest,
} from "./openai-translator.js";
import type { AgentRegistry } from "../../agents/agent-registry.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import { config } from "../../config.js";

const log = createLogger("voice-adapter");

interface CallSession {
  callId: string;
  agentId: string;
  startedAt: Date;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export class VoiceAdapter {
  private httpServer: ReturnType<typeof createServer> | undefined;
  private anthropic: Anthropic;
  private sessions = new Map<string, CallSession>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private port: number,
    private serverSecret: string,
    private registry: AgentRegistry,
    private memoryManager: MemoryManager,
  ) {
    this.anthropic = new Anthropic();
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error("Voice request handler error", { error: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, () => resolve());
    });

    // Sweep stale sessions every 30 minutes
    this.sweepTimer = setInterval(() => this.sweepStaleSessions(), 30 * 60 * 1000);

    log.info("Voice adapter started", { port: this.port });
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.httpServer?.close();
    log.info("Voice adapter stopped");
  }

  private sweepStaleSessions(): void {
    const now = Date.now();
    let swept = 0;
    for (const [callId, session] of this.sessions) {
      if (now - session.startedAt.getTime() > SESSION_TTL_MS) {
        this.sessions.delete(callId);
        swept++;
      }
    }
    if (swept > 0) {
      log.info("Swept stale voice sessions", { count: swept });
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeCalls: this.sessions.size }));
      return;
    }

    // Only accept POST /v1/chat/completions
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Authenticate — fail-closed
    if (!this.serverSecret) {
      log.error("Voice endpoint called but VAPI_SERVER_SECRET not configured — rejecting");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server secret not configured" }));
      return;
    }

    const providedSecret =
      (req.headers["x-vapi-secret"] as string) ??
      (req.headers["server-secret"] as string) ??
      "";
    if (providedSecret !== this.serverSecret) {
      log.warn("Voice request rejected — invalid server secret");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Parse request body
    const body = await readBody(req);
    let request: OpenAIChatRequest;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Resolve agent ID from Vapi metadata
    const agentId = this.resolveAgentId(request);
    if (!agentId) {
      log.error("Could not resolve agent ID from Vapi request");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Cannot determine agent identity" }));
      return;
    }

    const agentConfig = this.registry.get(agentId);
    if (!agentConfig) {
      log.error("Agent not found", { agentId });
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Agent not found: ${agentId}` }));
      return;
    }

    // Track session
    const callId = request.call?.id ?? randomUUID();
    if (!this.sessions.has(callId)) {
      this.sessions.set(callId, {
        callId,
        agentId,
        startedAt: new Date(),
      });
      log.info("Voice call session started", { callId, agentId });
    }

    // Build system prompt with call context
    const callMeta = request.call?.metadata as Record<string, string> | undefined;
    const systemPrompt = await buildVoiceSystemPrompt(
      agentConfig,
      this.memoryManager,
      {
        goal: callMeta?.goal,
        context: callMeta?.context,
      },
    );

    // Translate OpenAI → Claude
    const { system, messages } = openaiToClaude(request.messages, systemPrompt);
    const tools = openaiToolsToClaude(request.tools);

    const model = agentConfig.model;

    const completionId = `chatcmpl-${randomUUID()}`;

    if (request.stream === false) {
      // Non-streaming response
      const response = await this.anthropic.messages.create({
        model,
        max_tokens: 1024,
        system,
        messages,
        ...(tools ? { tools } : {}),
      });

      const textBlocks = response.content.filter((b) => b.type === "text");
      const text = textBlocks.map((b) => (b as Anthropic.TextBlock).text).join("");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(formatNonStreamingResponse(completionId, text, model)));
      return;
    }

    // Streaming response (default — Vapi always sends stream: true)
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    try {
      const stream = this.anthropic.messages.stream({
        model,
        max_tokens: 1024,
        system,
        messages,
        ...(tools ? { tools } : {}),
      });

      // PoC: text streaming only. Tool call streaming (tool_use blocks → OpenAI
      // tool_calls format) is deferred to Phase 2 when live tool calling is wired.
      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          const delta = event.delta as any;
          if (delta.type === "text_delta") {
            res.write(formatSSETextChunk(completionId, delta.text, model));
          }
        }
      }

      // Final done
      if (!res.writableEnded) {
        res.write(formatSSEDone(completionId, model));
      }
    } catch (err) {
      log.error("Claude streaming error", { error: String(err), callId, agentId });
      if (!res.writableEnded) {
        res.write(formatSSEDone(completionId, model, "error"));
      }
    }

    res.end();
  }

  /**
   * Resolve Hive agent ID from Vapi request metadata.
   *
   * Priority:
   * 1. assistant.metadata.hive_agent_id (set in Vapi dashboard)
   * 2. voice.assistants mapping in hive.yaml (Vapi assistant ID → Hive agent ID)
   * 3. call.metadata.hive_agent_id (set when initiating call via MCP)
   */
  private resolveAgentId(request: OpenAIChatRequest): string | undefined {
    // From assistant metadata
    const assistantMeta = request.assistant?.metadata as Record<string, string> | undefined;
    if (assistantMeta?.hive_agent_id) return assistantMeta.hive_agent_id;

    // From config mapping
    const assistantId = request.assistant?.id;
    if (assistantId && config.voice.assistants[assistantId]) {
      return config.voice.assistants[assistantId];
    }

    // From call metadata
    const callMeta = request.call?.metadata as Record<string, string> | undefined;
    if (callMeta?.hive_agent_id) return callMeta.hive_agent_id;

    return undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
