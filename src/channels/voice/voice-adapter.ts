import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logging/logger.js";
import { buildVoiceSystemPrompt } from "../../agents/prompt-builder.js";
import { renderConversationPrompt, extractLatestUserMessage } from "./conversation-prompt.js";
import {
  formatSSETextChunk,
  formatSSEDone,
  formatNonStreamingResponse,
  type OpenAIChatRequest,
} from "./openai-translator.js";
import type { AgentRegistry } from "../../agents/agent-registry.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import type { AgentManager, SpawnTurnStreamCallback, TurnContext, TurnResult } from "../../agents/agent-manager.js";
import type { Dispatcher } from "../../channels/dispatcher.js";
import type { WorkItem } from "../../types/work-item.js";
import { config } from "../../config.js";
import { ProviderCircuitOpenError } from "../../agents/provider-circuit-breaker.js";
import { VOICE_OUTAGE_SPOKEN_NOTICE } from "../../outage/outage-notices.js";

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
  sdkSessionId?: string;
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
    /**
     * KPR-220 Phase 8: required. The inline direct-`query()` fallback path
     * has retired; every voice turn now routes through
     * spawnTurnViaAgentManager. Constructing without it throws.
     */
    private agentManager: AgentManager,
    /**
     * KPR-223: optional dispatcher reference. When wired, voice turns route
     * through `dispatcher.routeVoiceTurn` (which applies taskLedger + audit
     * log; dedup is intentionally skipped). Falls back to direct
     * `agentManager.spawnTurn` when absent — preserves unit-test wiring
     * that doesn't need the full dispatcher.
     */
    private dispatcher?: Dispatcher,
  ) {
    if (!agentManager) {
      throw new Error("VoiceAdapter requires AgentManager (KPR-220 Phase 8 retired the direct-query fallback)");
    }
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

    // KPR-220 Phase 8/9: voice always routes through spawnTurnViaAgentManager;
    // the inline direct-`query()` fallback and the legacy perTurnSpawn.voice
    // flag have both been retired.
    return this.spawnTurnViaAgentManager(res, request, agentId, agentConfig, callId);
  }

  /**
   * KPR-219: per-turn spawn through AgentManager. Replaces the inline `query()`
   * spawn at lines 204-223 (the `buildQuery` builder + `runTurn` loop).
   *
   * Routes voice turns through the same per-thread lock + per-agent budget +
   * session-store path as SMS/Slack/WS. Voice's existing outer
   * retry-on-resume-fail logic stays around the spawnTurn call — it catches
   * cases spawnTurn's inner auth-retry doesn't (stale session id without an
   * auth-error pattern). The two retry layers compose intentionally; see plan
   * Q4 / spec §D4a.
   *
   * Streaming: onStream relays each text-delta chunk to SSE. AgentRunner.send
   * filters for `stream_event/content_block_delta/text_delta` upstream and
   * invokes the callback with the extracted text string — voice does NOT see
   * raw `SDKMessage` here. firstTokenMs captured on first non-empty chunk for
   * telemetry parity with the KPR-207 baseline log shape.
   */
  private async spawnTurnViaAgentManager(
    res: ServerResponse,
    request: OpenAIChatRequest,
    agentId: string,
    agentConfig: NonNullable<ReturnType<AgentRegistry["get"]>>,
    callId: string,
  ): Promise<void> {
    const agentManager = this.agentManager!;
    const completionId = `chatcmpl-${randomUUID()}`;
    const startedAt = Date.now();
    const isStreaming = request.stream !== false;
    const threadId = `voice:${callId}`;
    const callMeta = request.call?.metadata as Record<string, string> | undefined;
    const model = agentConfig.model;

    // Voice-specific system prompt — omits tool summaries / delegate
    // descriptions, adds call goal/context. AgentRunner consumes via
    // TurnContext.systemPromptOverride.
    const systemPrompt = await buildVoiceSystemPrompt(agentConfig, this.memoryManager, {
      goal: callMeta?.goal,
      context: callMeta?.context,
    });

    const sessionStore = agentManager.getSessionStore();
    const storedSessionId = await sessionStore.get(agentId, threadId);

    // Choose prompt based on resume-presence (mirrors current voice behavior).
    const turnPrompt = storedSessionId
      ? extractLatestUserMessage(request.messages)
      : renderConversationPrompt(request.messages);
    const safePrompt = storedSessionId && !turnPrompt ? renderConversationPrompt(request.messages) : turnPrompt;
    const effectiveResume = storedSessionId && turnPrompt ? storedSessionId : undefined;

    // Synthesize a WorkItem. ChannelKind="voice" was added in Step 1 of this
    // ticket so this compiles.
    const workItem: WorkItem = {
      id: callId,
      text: safePrompt,
      source: { kind: "voice", id: callId, label: `voice:${callId}` },
      sender: callId,
      threadId,
      timestamp: new Date(),
      meta: { callId, ...(callMeta ?? {}) },
    };

    let firstTokenMs: number | undefined;
    let headersSent = false;
    const onStream: SpawnTurnStreamCallback | undefined = isStreaming
      ? (chunk: string) => {
          // chunk is the pre-extracted text-delta string (StreamCallback shape
          // = `(chunk: string) => void`). Defensive empty-skip mirrors the
          // legacy inline loop's behavior.
          if (!chunk) return;
          if (!headersSent) {
            res.writeHead(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            });
            headersSent = true;
            firstTokenMs = Date.now() - startedAt;
          }
          res.write(formatSSETextChunk(completionId, chunk, model));
        }
      : undefined;

    const ctx: TurnContext = {
      agentId,
      sessionId: effectiveResume,
      channelId: callId,
      threadId,
      workItem,
      channel: "voice",
      systemPromptOverride: systemPrompt,
    };

    const runOnce = async (
      spawnCtx: TurnContext,
    ): Promise<
      | { ok: true; result: TurnResult; bytesSent: boolean }
      | { ok: false; reason: string; circuitOpen?: boolean; bytesSent: boolean }
    > => {
      try {
        // KPR-223: route through dispatcher when wired (applies taskLedger +
        // audit log; dedup intentionally skipped — see Dispatcher.routeVoiceTurn).
        // Fall back to direct spawnTurn for unit-test wiring without dispatcher.
        const result = this.dispatcher
          ? await this.dispatcher.routeVoiceTurn(spawnCtx, onStream)
          : await agentManager.spawnTurn(spawnCtx, onStream);
        if (result.errors.length > 0) {
          return { ok: false, reason: result.errors[0]!, bytesSent: headersSent };
        }
        return { ok: true, result, bytesSent: headersSent };
      } catch (err) {
        return {
          ok: false,
          reason: String(err),
          // KPR-307: detected here (instanceof survives — same process) so the
          // failure block below can speak an honest completion, not a 500.
          circuitOpen: err instanceof ProviderCircuitOpenError,
          bytesSent: headersSent,
        };
      }
    };

    let outcome = await runOnce(ctx);
    let outerRetryFired = false;

    // Outer retry — resume failed before any bytes hit the wire. Restart with
    // full transcript and no resume id. Mirrors voice-adapter.ts:320-329 from
    // the legacy path. Catches cases spawnTurn's inner auth-retry doesn't
    // cover (stale id without auth-error pattern, etc.).
    if (!outcome.ok && !outcome.circuitOpen && effectiveResume && !outcome.bytesSent) {
      log.warn("Voice spawnTurn resume failed, retrying as turn-1", {
        callId,
        reason: outcome.reason,
      });
      outerRetryFired = true;
      const fullPrompt = renderConversationPrompt(request.messages);
      const retryWorkItem: WorkItem = { ...workItem, text: fullPrompt };
      const retryCtx: TurnContext = {
        ...ctx,
        sessionId: undefined,
        workItem: retryWorkItem,
      };
      outcome = await runOnce(retryCtx);
    }

    if (!outcome.ok) {
      if (outcome.circuitOpen) {
        // KPR-307 §5-1b: honest SPOKEN completion — today's baseline is a
        // generic 500 "Internal error" (only auth/budget get 503s), and both
        // a bare 500 and a 503 render as dead air to Vapi. ⚠ Confirm Vapi
        // renders a normal completion better than a 500/503 during rollout.
        log.warn("Voice turn fast-failed — provider circuit open, speaking outage notice", {
          callId,
          agentId,
        });
        this.endWithSpokenText(res, VOICE_OUTAGE_SPOKEN_NOTICE, isStreaming, outcome.bytesSent, completionId, model);
        return;
      }
      if (isAuthError(outcome.reason)) {
        log.error("Voice spawnTurn failed — OAuth credentials unavailable", {
          callId,
          agentId,
          reason: outcome.reason,
        });
        this.endWithError(res, 503, "Voice unavailable", outcome.bytesSent, completionId, model);
        return;
      }
      if (outcome.reason.includes("Spawn budget exceeded")) {
        log.error("Voice spawnTurn rejected — spawn budget exceeded", {
          callId,
          agentId,
          reason: outcome.reason,
        });
        this.endWithError(res, 503, "Voice temporarily unavailable", outcome.bytesSent, completionId, model);
        return;
      }
      log.error("Voice spawnTurn failed", {
        callId,
        agentId,
        reason: outcome.reason,
        bytesSent: outcome.bytesSent,
      });
      this.endWithError(res, 500, "Internal error", outcome.bytesSent, completionId, model);
      return;
    }

    const result = outcome.result;

    // Success — finalize the response shape.
    if (isStreaming) {
      if (!headersSent) {
        // Resume produced no streamed text (degenerate: e.g. zero-content
        // turn). Emit the standard SSE close anyway so Vapi ends cleanly.
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        headersSent = true;
      }
      res.write(formatSSEDone(completionId, model));
      res.end();
    } else {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(formatNonStreamingResponse(completionId, result.finalMessage, model)));
    }

    // Telemetry parity with KPR-207 baseline (voice-adapter.ts:370-379).
    // sdkSessionResumed = "we attempted resume AND the spawn succeeded
    // without the outer-retry kicking in" — NOT `newSessionId === effectiveResume`,
    // because the SDK rotates session ids post-compaction, which would
    // systematically under-count successful resumes versus the baseline.
    // The `!outerRetryFired` clause matches the legacy adapter's semantic
    // exactly: when retry fires, the original resume failed, so this counts
    // as a non-resumed turn even if the retry succeeded.
    log.info("Voice turn complete", {
      callId,
      agentId,
      firstTokenMs,
      totalMs: Date.now() - startedAt,
      mode: isStreaming ? "streaming" : "non-streaming",
      sdkSessionResumeAttempted: !!effectiveResume,
      sdkSessionResumed: !!effectiveResume && outcome.ok && !outerRetryFired,
      routedVia: "agentManager",
    });
  }

  /**
   * KPR-219: end the response with an error sentinel. Branches between
   * `writeHead`+`end` for the no-bytes-sent case (clean HTTP error) and an
   * SSE error close for the bytes-already-sent case (best we can do
   * mid-stream). Net-new helper extracted to avoid duplicating the branch
   * across the three error paths in `spawnTurnViaAgentManager`.
   */
  private endWithError(
    res: ServerResponse,
    status: number,
    message: string,
    bytesSent: boolean,
    completionId: string,
    model: string,
  ): void {
    if (!bytesSent) {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: message }));
      return;
    }
    if (!res.writableEnded) {
      res.write(formatSSEDone(completionId, model, "error"));
      res.end();
    }
  }

  /**
   * KPR-307: end the turn with a normal 200 completion carrying spoken text.
   * Streaming: emit one SSE text chunk + the standard done frame (headers
   * lazily if no bytes were sent yet). Non-streaming: standard JSON body.
   */
  private endWithSpokenText(
    res: ServerResponse,
    text: string,
    isStreaming: boolean,
    bytesSent: boolean,
    completionId: string,
    model: string,
  ): void {
    if (isStreaming) {
      if (!bytesSent) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
      }
      if (!res.writableEnded) {
        res.write(formatSSETextChunk(completionId, text, model));
        res.write(formatSSEDone(completionId, model));
        res.end();
      }
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(formatNonStreamingResponse(completionId, text, model)));
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
