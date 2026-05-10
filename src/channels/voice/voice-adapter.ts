import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logging/logger.js";
import { buildVoiceSystemPrompt } from "../../agents/prompt-builder.js";
import { renderConversationPrompt } from "./conversation-prompt.js";
import {
  formatSSETextChunk,
  formatSSEDone,
  formatNonStreamingResponse,
  type OpenAIChatRequest,
} from "./openai-translator.js";
import type { AgentRegistry } from "../../agents/agent-registry.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import { config } from "../../config.js";

const log = createLogger("voice-adapter");

// Exported for unit tests.
export function isAuthError(err: unknown): boolean {
  const s = String(err);
  return /resolve authentication|credentials\.json|not authenticated|401 Unauthorized|ANTHROPIC_API_KEY|authToken/i.test(
    s,
  );
}

interface CallSession {
  callId: string;
  agentId: string;
  startedAt: Date;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export class VoiceAdapter {
  private httpServer: ReturnType<typeof createServer> | undefined;
  private sessions = new Map<string, CallSession>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private port: number,
    private serverSecret: string,
    private registry: AgentRegistry,
    private memoryManager: MemoryManager,
  ) {}

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
    if (!this.serverSecret) {
      log.error("Voice endpoint called but VAPI_SERVER_SECRET not configured — rejecting");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server secret not configured" }));
      return;
    }

    const authHeader = (req.headers["authorization"] as string) ?? "";
    const bearerSecret = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : "";
    const providedSecret =
      (req.headers["x-vapi-secret"] as string) ?? (req.headers["server-secret"] as string) ?? bearerSecret ?? "";
    const hasValidSecret = providedSecret === this.serverSecret;

    // Custom LLM endpoint: Vapi sends `Authorization: Bearer no-credentials-provided`
    // by default; their schema has no per-assistant API-key field. Auth this path by
    // verifying the body's assistant.id maps to a configured agent — the UUID is
    // the bearer token. Other paths still require the shared secret.
    if (req.method === "POST" && req.url === "/v1/chat/completions") {
      const body = await readBody(req);
      let request: OpenAIChatRequest;
      try {
        request = JSON.parse(body);
      } catch {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Invalid JSON" }));
        return;
      }

      const agentId = this.resolveAgentId(request);
      if (!agentId) {
        log.warn("Voice request rejected — could not resolve agent from request body", {
          assistantId: request.assistant?.id,
          hasMetadata: !!request.assistant?.metadata,
        });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      const agentConfig = this.registry.get(agentId);
      if (!agentConfig) {
        log.warn("Voice request rejected — agent not in registry", { agentId });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      return this.handleChatCompletion(req, res, request, agentId, agentConfig);
    }

    // All other paths require the shared secret.
    if (!hasValidSecret) {
      log.warn("Voice request rejected — invalid server secret", {
        url: req.url,
        method: req.method,
        hasXVapi: !!req.headers["x-vapi-secret"],
        hasAuthorization: !!authHeader,
      });
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeCalls: this.sessions.size }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  }

  private async handleChatCompletion(
    _req: IncomingMessage,
    res: ServerResponse,
    request: OpenAIChatRequest,
    agentId: string,
    agentConfig: NonNullable<ReturnType<AgentRegistry["get"]>>,
  ): Promise<void> {
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
    const systemPrompt = await buildVoiceSystemPrompt(agentConfig, this.memoryManager, {
      goal: callMeta?.goal,
      context: callMeta?.context,
    });

    // Build the user-side prompt from the conversation transcript
    const prompt = renderConversationPrompt(request.messages);

    const model = agentConfig.model;
    const completionId = `chatcmpl-${randomUUID()}`;
    const startedAt = Date.now();
    let firstTokenMs: number | undefined;

    // One-shot SDK query — no MCP servers, no hooks, no session reuse.
    // The SDK handles auth (ANTHROPIC_API_KEY env if set, else OAuth via the
    // claude CLI's ~/.claude/.credentials.json). On operator instances with
    // no API key configured, this falls through to the subscription path.
    const q = query({
      prompt,
      options: {
        model,
        systemPrompt,
        permissionMode: "bypassPermissions",
        allowDangerouslySkipPermissions: true,
        maxTurns: 1,
        settingSources: [],
        includePartialMessages: request.stream !== false,
        env: {
          ...process.env,
          ...(config.anthropic.apiKey ? { ANTHROPIC_API_KEY: config.anthropic.apiKey } : {}),
          CLAUDE_AGENT_SDK_CLIENT_APP: "hive/voice",
          CLAUDECODE: undefined,
        },
        extraArgs: { "strict-mcp-config": null },
      },
    });

    if (request.stream === false) {
      // Non-streaming: collect full text from result message.
      let text = "";
      let resultSubtype: string | undefined;
      try {
        for await (const message of q) {
          const msg = message as SDKMessage;
          if (msg.type === "assistant") {
            const content = (msg as any).message?.content;
            if (Array.isArray(content)) {
              for (const block of content) {
                if (block?.type === "text" && typeof block.text === "string") {
                  if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
                  text = block.text;
                }
              }
            }
          } else if (msg.type === "result") {
            resultSubtype = (msg as any).subtype;
            if (resultSubtype === "success") {
              text = (msg as any).result || text;
            }
          }
        }
      } catch (err) {
        if (isAuthError(err)) {
          log.error("Voice query failed — OAuth credentials unavailable", { error: String(err), callId, agentId });
          res.writeHead(503, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Voice unavailable" }));
          return;
        }
        log.error("Voice query error (non-streaming)", { error: String(err), callId, agentId });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
        return;
      }

      // Result subtype other than "success" → 500. Non-streaming is request/response
      // so we have not yet committed any bytes; we can still surface a clean error.
      if (resultSubtype && resultSubtype !== "success") {
        log.error("Voice query result reported failure", { callId, agentId, resultSubtype });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal error" }));
        return;
      }

      log.info("Voice turn complete", {
        callId,
        agentId,
        firstTokenMs,
        totalMs: Date.now() - startedAt,
        mode: "non-streaming",
      });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(formatNonStreamingResponse(completionId, text, model)));
      return;
    }

    // Streaming: peek the first SDK message to surface auth failures BEFORE
    // committing to SSE headers (which would lock us into a 200 response).
    const iter = q[Symbol.asyncIterator]();
    let firstMessage: IteratorResult<SDKMessage>;
    try {
      firstMessage = (await iter.next()) as IteratorResult<SDKMessage>;
    } catch (err) {
      if (isAuthError(err)) {
        log.error("Voice query failed — OAuth credentials unavailable", { error: String(err), callId, agentId });
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Voice unavailable" }));
        return;
      }
      log.error("Voice query error (streaming/init)", { error: String(err), callId, agentId });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal error" }));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });

    const handleStreamMessage = (msg: SDKMessage) => {
      if (msg.type === "stream_event") {
        const event = (msg as any).event;
        if (event?.type === "content_block_delta" && event?.delta?.type === "text_delta") {
          if (firstTokenMs === undefined) firstTokenMs = Date.now() - startedAt;
          res.write(formatSSETextChunk(completionId, event.delta.text ?? "", model));
        }
      }
    };

    let resultSubtype: string | undefined;
    try {
      const checkResult = (msg: SDKMessage) => {
        if (msg.type === "result") resultSubtype = (msg as any).subtype;
      };
      if (!firstMessage.done) {
        handleStreamMessage(firstMessage.value);
        checkResult(firstMessage.value);
      }
      while (true) {
        const next = await iter.next();
        if (next.done) break;
        const msg = next.value as SDKMessage;
        handleStreamMessage(msg);
        checkResult(msg);
      }
      if (!res.writableEnded) {
        // Non-success result is logged but not surfaced to Vapi mid-stream — caller
        // already heard whatever audio was emitted; abruptly ending the stream
        // would degrade more than it helps. Logging is enough to alert ops.
        if (resultSubtype && resultSubtype !== "success") {
          log.warn("Voice query result reported failure (post-stream)", { callId, agentId, resultSubtype });
        }
        res.write(formatSSEDone(completionId, model));
      }
    } catch (err) {
      log.error("Voice query error (streaming)", { error: String(err), callId, agentId });
      if (!res.writableEnded) {
        res.write(formatSSEDone(completionId, model, "error"));
      }
    }

    log.info("Voice turn complete", {
      callId,
      agentId,
      firstTokenMs,
      totalMs: Date.now() - startedAt,
      mode: "streaming",
      resultSubtype,
    });
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
