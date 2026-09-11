import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";
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
import {
  AgentStoppedError,
  type AgentManager,
  type SpawnTurnStreamCallback,
  type TurnContext,
  type TurnResult,
} from "../../agents/agent-manager.js";
import type { Dispatcher } from "../../channels/dispatcher.js";
import type { WorkItem } from "../../types/work-item.js";
import { config } from "../../config.js";
import { ProviderCircuitOpenError } from "../../agents/provider-circuit-breaker.js";
import { VOICE_OUTAGE_SPOKEN_NOTICE } from "../../outage/outage-notices.js";
import { VoiceRequestCancelledError, checkVoiceRequest } from "../../agents/voice-request-cancellation.js";
import {
  createVoiceTraceWriter,
  measure,
  parseVoiceTrace,
  voiceDiagnosticEvent,
  type AttemptOutcome,
  type EnginePayload,
  type VoiceErrorClass,
} from "../../voice/voice-trace.js";

const log = createLogger("voice-adapter");

// Exported for unit tests.
export function isAuthError(err: unknown): boolean {
  const s = String(err);
  return /resolve authentication|credentials\.json|not authenticated|401 Unauthorized|ANTHROPIC_API_KEY|authToken/i.test(
    s,
  );
}

/**
 * KPR-322 E1: constant-time bearer comparison. sha256 normalizes lengths so
 * timingSafeEqual never throws on length mismatch. Exported for unit tests.
 */
export function timingSafeTokenEqual(provided: string, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
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
    /** KPR-322 E1: shared bridge secret (HIVE_VOICE_BRIDGE_TOKEN). "" = LiveKit bridge disabled. */
    private bridgeToken: string,
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
    /** KPR-322 E1: loopback default — both callers are local. */
    private bindHost: string = "127.0.0.1",
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
      this.httpServer!.listen(this.port, this.bindHost, () => resolve());
    });

    // Sweep stale sessions every 30 minutes
    this.sweepTimer = setInterval(() => this.sweepStaleSessions(), 30 * 60 * 1000);

    log.info("Voice adapter started", { port: this.port, bindHost: this.bindHost });
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
    const authHeader = (req.headers["authorization"] as string) ?? "";
    const bearerSecret = authHeader.toLowerCase().startsWith("bearer ") ? authHeader.slice(7) : "";
    // KPR-322 E1: a matching bridge bearer authenticates the request as the
    // LiveKit worker, regardless of body shape. A present-but-NON-matching
    // bearer is NOT an immediate 401 — Vapi sends `Authorization: Bearer
    // no-credentials-provided` by default, so non-matching bearers fall
    // through to the Vapi shape check below.
    const isBridgeAuthed = this.bridgeToken !== "" && timingSafeTokenEqual(bearerSecret, this.bridgeToken);

    // Pre-E1 dead-endpoint gate, with the bridge carved out: a LiveKit-only
    // instance (no VAPI_SERVER_SECRET) must still serve bridge-authed turns.
    if (!this.serverSecret && !isBridgeAuthed) {
      log.error("Voice endpoint called but VAPI_SERVER_SECRET not configured — rejecting");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server secret not configured" }));
      return;
    }

    const providedSecret =
      (req.headers["x-vapi-secret"] as string) ?? (req.headers["server-secret"] as string) ?? bearerSecret ?? "";
    const hasValidSecret = providedSecret === this.serverSecret;

    // Custom LLM endpoint. Two authenticated shapes:
    //  (a) bridge: `Authorization: Bearer <HIVE_VOICE_BRIDGE_TOKEN>` — no
    //      `assistant` object; agent resolves via call.metadata.hive_agent_id.
    //  (b) Vapi: no/non-matching bearer, but Vapi-shaped — an `assistant`
    //      object present, resolving through the existing three-priority
    //      chain (assistant.metadata → voice.assistants map → call.metadata;
    //      the MCP-initiated flow legitimately uses call.metadata).
    // Anything neither token-bearing nor Vapi-shaped → 401. The worker sends
    // no `assistant`, so a wrong/missing token gets 401, never a spawn.
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

      if (!isBridgeAuthed && !request.assistant) {
        log.warn("Voice request rejected — no bridge token and not Vapi-shaped", {
          hasBearer: !!bearerSecret,
        });
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      const agentId = this.resolveAgentId(request);
      if (!agentId) {
        if (isBridgeAuthed) {
          // Authenticated bridge but malformed body — a request error, not auth.
          log.warn("Bridge request missing resolvable agent", { hasCallMeta: !!request.call?.metadata });
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "call.metadata.hive_agent_id required" }));
          return;
        }
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

    // All other paths require the shared secret (unchanged).
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
    const parsedTrace = parseVoiceTrace(request.metadata);
    const completionId = `chatcmpl-${parsedTrace.turnId}`;
    const startedAt = performance.now();
    const isStreaming = request.stream !== false;
    const threadId = `voice:${callId}`;
    const callMeta = request.call?.metadata as Record<string, string> | undefined;
    const model = agentConfig.model;
    const traceWriter = createVoiceTraceWriter(log);
    const requestAbort = new AbortController();
    let clientGone = res.destroyed === true;
    let writeFailed = false;
    let headersSent = false;
    let sentStatus: number | undefined;
    let firstTokenMs: number | undefined;
    let responseTextLength = 0;
    let responseCompleteMs: number | undefined;
    let pendingResponseWrites = 0;
    const responseWriteWaiters = new Set<() => void>();
    let engineAttemptSeq = 0;
    let requestOutcome: AttemptOutcome = "incomplete";
    let requestErrorClass: VoiceErrorClass | null = null;

    const emitEngine = (payload: EnginePayload, attemptSeq: number | null = null): void => {
      traceWriter.write(
        voiceDiagnosticEvent(
          {
            component: "voice-engine",
            callId,
            workerBootId: parsedTrace.workerBootId,
            turnId: parsedTrace.turnId,
            engineAttemptSeq: attemptSeq,
          },
          payload,
        ),
      );
    };
    const latchWriteFailure = (): void => {
      if (writeFailed) return;
      writeFailed = true;
      requestErrorClass = "sse_write_failed";
      requestAbort.abort();
    };
    const trackResponseWrite = (): ((error?: Error | null) => void) => {
      pendingResponseWrites += 1;
      let settled = false;
      return (error?: Error | null) => {
        if (settled) return;
        settled = true;
        pendingResponseWrites -= 1;
        if (error) latchWriteFailure();
        if (pendingResponseWrites === 0) {
          for (const waiter of [...responseWriteWaiters]) waiter();
          responseWriteWaiters.clear();
        }
      };
    };
    const settleResponseWrites = async (timeoutMs = 250): Promise<boolean> => {
      if (pendingResponseWrites === 0) return true;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          responseWriteWaiters.delete(finish);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        responseWriteWaiters.add(finish);
        if (pendingResponseWrites === 0) finish();
      });
      return pendingResponseWrites === 0;
    };
    const onResponseError = (): void => latchWriteFailure();
    const onFinish = (): void => {
      responseCompleteMs ??= performance.now() - startedAt;
    };
    const onClose = (): void => {
      if (res.writableEnded) return;
      clientGone = true;
      requestAbort.abort();
      emitEngine({ event: "engine_client_closed" });
    };
    res.on("close", onClose);
    res.on("error", onResponseError);
    res.on("finish", onFinish);
    if (clientGone) requestAbort.abort();

    const sendHeaders = (status: number, headers: Record<string, string>): boolean => {
      if (clientGone || res.destroyed || res.writableEnded || writeFailed) return false;
      res.writeHead(status, headers);
      headersSent = true;
      sentStatus = status;
      return true;
    };
    const writeChunk = (chunk: string, contentLength: number): boolean => {
      if (clientGone || res.destroyed || res.writableEnded || writeFailed) return false;
      const callback = trackResponseWrite();
      try {
        const acceptedWithoutBackpressure = res.write(chunk, callback);
        if (contentLength > 0) {
          responseTextLength += contentLength;
          if (firstTokenMs === undefined) {
            firstTokenMs = performance.now() - startedAt;
            emitEngine(
              {
                event: "engine_first_text",
                textLength: contentLength,
                firstTextMs: measure(firstTokenMs, "not_reached"),
              },
              engineAttemptSeq || null,
            );
          }
        }
        return acceptedWithoutBackpressure;
      } catch (error) {
        callback();
        latchWriteFailure();
        throw error;
      }
    };
    const endResponse = (chunk?: string): boolean => {
      if (clientGone || res.destroyed || res.writableEnded || writeFailed) return false;
      const callback = trackResponseWrite();
      try {
        const done = () => {
          responseCompleteMs ??= performance.now() - startedAt;
          callback();
        };
        if (chunk === undefined) res.end(done);
        else res.end(chunk, done);
        return true;
      } catch (error) {
        callback();
        latchWriteFailure();
        throw error;
      }
    };

    emitEngine({ event: "engine_received", correlation: parsedTrace.correlation });
    if (parsedTrace.correlation === "invalid") {
      traceWriter.write(
        voiceDiagnosticEvent(
          { component: "voice-engine", callId, turnId: parsedTrace.turnId },
          { event: "diagnostic_gap", reason: "correlation_missing", count: 1 },
        ),
      );
    }

    let promptBuildMs: number | undefined;
    let sessionLookupMs: number | undefined;
    let continuityAttempted = false;
    let outerRetryFired = false;
    let finalResult: TurnResult | undefined;

    try {
      if (!this.sessions.has(callId)) {
        this.sessions.set(callId, { callId, agentId, startedAt: new Date() });
        log.info("Voice call session started", { callId, agentId });
      }

      // Voice-specific system prompt — omits tool summaries / delegate
      // descriptions, adds call goal/context. AgentRunner consumes via
      // TurnContext.systemPromptOverride.
      const promptBuildStartedAt = performance.now(); // KPR-323 C1: T0→T1
      const systemPrompt = await buildVoiceSystemPrompt(agentConfig, this.memoryManager, {
        goal: callMeta?.goal,
        context: callMeta?.context,
      });
      promptBuildMs = performance.now() - promptBuildStartedAt;
      checkVoiceRequest(requestAbort.signal);

      const sessionStore = agentManager.getSessionStore();
      const sessionLookupStartedAt = performance.now(); // KPR-323 C1: T0→T1
      const storedRef = await sessionStore.get(agentId, threadId);
      sessionLookupMs = performance.now() - sessionLookupStartedAt;
      checkVoiceRequest(requestAbort.signal);

      // KPR-467: carry both prompt forms and the stored resume candidate to
      // admission. Only the manager knows whether this turn uses a pinned
      // lease, a compatible resume, or a fresh route after a registry reload.
      const voicePrompt = {
        latestUserMessage: extractLatestUserMessage(request.messages),
        fullConversation: renderConversationPrompt(request.messages),
      };
      const effectiveResume = voicePrompt.latestUserMessage ? storedRef?.sessionId : undefined;
      const safePrompt = effectiveResume ? voicePrompt.latestUserMessage : voicePrompt.fullConversation;

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

      const onStream: SpawnTurnStreamCallback | undefined = isStreaming
        ? (chunk: string) => {
            // chunk is the pre-extracted text-delta string (StreamCallback shape
            // = `(chunk: string) => void`). Defensive empty-skip mirrors the
            // legacy inline loop's behavior.
            if (!chunk || clientGone || requestAbort.signal.aborted) return;
            if (!headersSent) {
              if (
                !sendHeaders(200, {
                  "Content-Type": "text/event-stream",
                  "Cache-Control": "no-cache",
                  Connection: "keep-alive",
                })
              )
                return;
            }
            writeChunk(formatSSETextChunk(completionId, chunk, model), chunk.length);
          }
        : undefined;

      const ctx: TurnContext = {
        agentId,
        sessionId: effectiveResume,
        sessionProvider: effectiveResume ? storedRef?.provider : undefined,
        voicePrompt,
        channelId: callId,
        threadId,
        workItem,
        channel: "voice",
        systemPromptOverride: systemPrompt,
        voiceRequestSignal: requestAbort.signal,
      };

      let hasAdmittedContinuity = false;
      type RunFailure = {
        ok: false;
        reason: string;
        circuitOpen?: boolean;
        bytesSent: boolean;
        cancelled?: boolean;
        stopped?: boolean;
        voiceLifetimeSignal?: AbortSignal;
      };
      type RunOutcome =
        | {
            ok: true;
            result: TurnResult;
            bytesSent: boolean;
            selectedContinuity: "fresh" | "resume" | "warm" | null;
          }
        | RunFailure;
      const getVoiceStopError = (signal?: AbortSignal): AgentStoppedError | undefined =>
        signal?.aborted && signal.reason instanceof AgentStoppedError ? signal.reason : undefined;
      const runOnce = async (
        baseCtx: TurnContext,
        continuity: "fresh" | "resume" | "full_transcript",
      ): Promise<RunOutcome> => {
        engineAttemptSeq += 1;
        const attemptSeq = engineAttemptSeq;
        const attemptStartedAt = performance.now();
        let launchAdmission: "fresh" | "resume" | null = null;
        let selectedContinuity: "fresh" | "resume" | "warm" | null = null;
        let voiceLifetimeSignal: AbortSignal | undefined;
        let attemptResult: TurnResult | undefined;
        let attemptFailure: RunFailure | undefined;
        hasAdmittedContinuity = false;
        emitEngine({ event: "engine_attempt_started", continuity }, attemptSeq);
        const spawnCtx: TurnContext = {
          ...baseCtx,
          onVoiceLaunchAdmission: (admission) => {
            launchAdmission = admission;
            hasAdmittedContinuity ||= admission === "resume";
          },
          onVoiceAdmission: (admission) => {
            selectedContinuity = admission;
            hasAdmittedContinuity ||= admission === "warm" || admission === "resume";
          },
          onVoiceLifetimeAdmission: (signal) => {
            voiceLifetimeSignal = signal;
          },
        };
        try {
          checkVoiceRequest(requestAbort.signal);
          // KPR-223: route through dispatcher when wired (applies taskLedger +
          // audit log; dedup intentionally skipped — see Dispatcher.routeVoiceTurn).
          // Fall back to direct spawnTurn for unit-test wiring without dispatcher.
          const result = this.dispatcher
            ? await this.dispatcher.routeVoiceTurn(spawnCtx, onStream)
            : await agentManager.spawnTurn(spawnCtx, onStream);
          voiceLifetimeSignal = result.voiceLifetimeSignal ?? voiceLifetimeSignal;
          attemptResult = result;
          if (writeFailed) {
            attemptFailure = {
              ok: false,
              reason: "Response write failed",
              bytesSent: headersSent,
              cancelled: false,
              voiceLifetimeSignal,
            };
            return attemptFailure;
          }
          if (result.errors.length > 0) {
            const stoppedError = getVoiceStopError(voiceLifetimeSignal);
            attemptFailure = {
              ok: false,
              reason: stoppedError ? String(stoppedError) : result.errors[0]!,
              bytesSent: headersSent,
              cancelled: requestAbort.signal.aborted,
              stopped: stoppedError !== undefined,
              voiceLifetimeSignal,
            };
            return attemptFailure;
          }
          return { ok: true, result, bytesSent: headersSent, selectedContinuity };
        } catch (err) {
          const stoppedError = getVoiceStopError(voiceLifetimeSignal);
          attemptFailure = {
            ok: false,
            reason: String(stoppedError ?? err),
            // KPR-307: detected here (instanceof survives — same process) so the
            // failure block below can speak an honest completion, not a 500.
            circuitOpen: err instanceof ProviderCircuitOpenError,
            bytesSent: headersSent,
            cancelled: err instanceof VoiceRequestCancelledError,
            stopped: err instanceof AgentStoppedError || stoppedError !== undefined,
            voiceLifetimeSignal,
          };
          return attemptFailure;
        } finally {
          const stoppedError = getVoiceStopError(voiceLifetimeSignal);
          const attemptOutcome: AttemptOutcome = writeFailed
            ? "failed"
            : attemptFailure
              ? attemptFailure.cancelled
                ? "cancelled"
                : "failed"
              : attemptResult?.aborted
                ? "cancelled"
                : "completed";
          const errorClass: VoiceErrorClass | null = writeFailed
            ? "sse_write_failed"
            : attemptFailure
              ? attemptFailure.cancelled
                ? null
                : attemptFailure.circuitOpen
                  ? "llm_provider_failed"
                  : isAuthError(attemptFailure.reason)
                    ? "engine_auth"
                    : "spawn_failed"
              : null;
          emitEngine(
            {
              event: "engine_attempt_terminal",
              continuity,
              launchAdmission,
              selectedContinuity,
              warm: attemptResult?.warmPath ?? selectedContinuity === "warm",
              toolCount: attemptResult?.toolCalls,
              toolMs: attemptResult?.toolMs,
              toolAckInjected:
                attemptResult?.toolAckInjected === undefined ? undefined : attemptResult.toolAckInjected > 0,
              outcome: attemptOutcome,
              errorClass,
              durationMs: measure(performance.now() - attemptStartedAt, "not_observed"),
              lockWaitMs: measure(attemptResult?.stageTimings?.lockWaitMs, "not_observed"),
              spawnPrepMs: measure(attemptResult?.stageTimings?.spawnPrepMs, "not_observed"),
              initToFirstTokenMs: measure(attemptResult?.stageTimings?.initToFirstTokenMs, "not_observed"),
              firstTextMs: measure(firstTokenMs, "not_reached"),
              stopped: stoppedError !== undefined || attemptFailure?.stopped === true,
            },
            attemptSeq,
          );
        }
      };

      if (clientGone) {
        requestOutcome = writeFailed ? "failed" : "cancelled";
        log.info("Voice turn skipped — client disconnected before spawn", { callId, agentId });
        return;
      }

      checkVoiceRequest(requestAbort.signal);
      let outcome = await runOnce(ctx, effectiveResume ? "resume" : "fresh");
      continuityAttempted = hasAdmittedContinuity;
      if (!outcome.ok) {
        const stoppedError = getVoiceStopError(outcome.voiceLifetimeSignal);
        if (stoppedError) outcome = { ...outcome, stopped: true, reason: String(stoppedError) };
      }

      // Outer retry — admitted lease/resume failed before any bytes hit the wire. Restart with
      // full transcript and no resume id. Mirrors voice-adapter.ts:320-329 from
      // the legacy path. Catches cases spawnTurn's inner auth-retry doesn't
      // cover (stale id without auth-error pattern, etc.).
      //
      // KPR-324 semantics note: `bytesSent` (= headersSent) now flips true on a
      // hive-injected tool-start ack too, not just model text — the ack goes
      // through this same `onStream`/SSE path. That is intentional: once the
      // caller has HEARD the ack, replaying the turn would double-speak it, so
      // an ack-only turn is correctly treated as "already on the wire" and is
      // not retried here.
      if (
        !outcome.ok &&
        !outcome.circuitOpen &&
        !outcome.cancelled &&
        !outcome.stopped &&
        !getVoiceStopError(outcome.voiceLifetimeSignal) &&
        hasAdmittedContinuity &&
        !outcome.bytesSent &&
        !clientGone &&
        !requestAbort.signal.aborted
      ) {
        log.warn("Voice spawnTurn resume failed, retrying as turn-1", {
          callId,
          reason: outcome.reason,
        });
        const fullPrompt = renderConversationPrompt(request.messages);
        const retryWorkItem: WorkItem = { ...workItem, text: fullPrompt };
        const retryCtx: TurnContext = {
          ...ctx,
          sessionId: undefined,
          sessionProvider: undefined,
          workItem: retryWorkItem,
        };
        const stoppedBeforeRetry = getVoiceStopError(outcome.voiceLifetimeSignal);
        if (stoppedBeforeRetry) {
          outcome = { ...outcome, stopped: true, reason: String(stoppedBeforeRetry) };
        } else if (!requestAbort.signal.aborted && !clientGone) {
          outerRetryFired = true;
          outcome = await runOnce(retryCtx, "full_transcript");
        }
      }
      if (!outcome.ok) {
        const stoppedError = getVoiceStopError(outcome.voiceLifetimeSignal);
        if (stoppedError) outcome = { ...outcome, stopped: true, reason: String(stoppedError) };
      }

      // E2: never write into a dead socket — the turn (aborted or completed)
      // ends silently; next turn's resume either works or trips the outer
      // full-transcript retry (recoverable by construction, spec §7).
      if (clientGone || requestAbort.signal.aborted) {
        requestOutcome = writeFailed ? "failed" : "cancelled";
        log.info("Voice turn ended after client disconnect — response suppressed", {
          callId,
          agentId,
          ok: outcome.ok,
          aborted: outcome.ok ? (outcome.result.aborted ?? false) : undefined,
        });
        return;
      }

      if (!outcome.ok) {
        requestOutcome = "failed";
        if (outcome.circuitOpen) {
          // KPR-307 §5-1b: honest SPOKEN completion — today's baseline is a
          // generic 500 "Internal error" (only auth/budget get 503s), and both
          // a bare 500 and a 503 render as dead air to Vapi. ⚠ Confirm Vapi
          // renders a normal completion better than a 500/503 during rollout.
          log.warn("Voice turn fast-failed — provider circuit open, speaking outage notice", {
            callId,
            agentId,
          });
          requestErrorClass = "llm_provider_failed";
          if (isStreaming) {
            if (
              outcome.bytesSent ||
              sendHeaders(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
              })
            ) {
              writeChunk(
                formatSSETextChunk(completionId, VOICE_OUTAGE_SPOKEN_NOTICE, model),
                VOICE_OUTAGE_SPOKEN_NOTICE.length,
              );
              writeChunk(formatSSEDone(completionId, model), 0);
              endResponse();
            }
          } else {
            const body = JSON.stringify(formatNonStreamingResponse(completionId, VOICE_OUTAGE_SPOKEN_NOTICE, model));
            responseTextLength = VOICE_OUTAGE_SPOKEN_NOTICE.length;
            if (sendHeaders(200, { "Content-Type": "application/json" })) endResponse(body);
          }
          return;
        }
        if (isAuthError(outcome.reason)) {
          requestErrorClass = "engine_auth";
          log.error("Voice spawnTurn failed — OAuth credentials unavailable", {
            callId,
            agentId,
            reason: outcome.reason,
          });
          if (!outcome.bytesSent) {
            if (sendHeaders(503, { "Content-Type": "application/json" })) {
              endResponse(JSON.stringify({ error: "Voice unavailable" }));
            }
          } else {
            writeChunk(formatSSEDone(completionId, model, "error"), 0);
            endResponse();
          }
          return;
        }
        if (outcome.reason.includes("Spawn budget exceeded")) {
          requestErrorClass = "budget_saturated";
          log.error("Voice spawnTurn rejected — spawn budget exceeded", {
            callId,
            agentId,
            reason: outcome.reason,
          });
          if (!outcome.bytesSent) {
            if (sendHeaders(503, { "Content-Type": "application/json" })) {
              endResponse(JSON.stringify({ error: "Voice temporarily unavailable" }));
            }
          } else {
            writeChunk(formatSSEDone(completionId, model, "error"), 0);
            endResponse();
          }
          return;
        }
        log.error("Voice spawnTurn failed", {
          callId,
          agentId,
          reason: outcome.reason,
          bytesSent: outcome.bytesSent,
        });
        requestErrorClass = writeFailed ? "sse_write_failed" : "spawn_failed";
        if (!outcome.bytesSent) {
          if (sendHeaders(500, { "Content-Type": "application/json" })) {
            endResponse(JSON.stringify({ error: "Internal error" }));
          }
        } else {
          writeChunk(formatSSEDone(completionId, model, "error"), 0);
          endResponse();
        }
        return;
      }

      const result = outcome.result;
      finalResult = result;
      requestOutcome = result.aborted ? "cancelled" : "completed";

      // Success — finalize the response shape.
      if (isStreaming) {
        if (!headersSent) {
          // Resume produced no streamed text (degenerate: e.g. zero-content
          // turn). Emit the standard SSE close anyway so Vapi ends cleanly.
          if (
            !sendHeaders(200, {
              "Content-Type": "text/event-stream",
              "Cache-Control": "no-cache",
              Connection: "keep-alive",
            })
          )
            return;
        }
        writeChunk(formatSSEDone(completionId, model), 0);
        endResponse();
      } else {
        const body = JSON.stringify(formatNonStreamingResponse(completionId, result.finalMessage, model));
        responseTextLength = result.finalMessage.length;
        if (sendHeaders(200, { "Content-Type": "application/json" })) endResponse(body);
      }

      // Telemetry parity with KPR-207 baseline (voice-adapter.ts:370-379).
      // Admission, including an active lease without a store row, is the
      // continuity source for both returned and thrown failures.
      // sdkSessionResumed = "we attempted continuity AND the spawn succeeded
      // without the outer-retry kicking in" — NOT `newSessionId === effectiveResume`,
      // because the SDK rotates session ids post-compaction, which would
      // systematically under-count successful resumes versus the baseline.
      // The `!outerRetryFired` clause matches the legacy adapter's semantic
      // exactly: when retry fires, the original resume failed, so this counts
      // as a non-resumed turn even if the retry succeeded.
      log.info("Voice turn complete", {
        callId,
        agentId,
        // Engine text emission, including a tool hold phrase. This is not an
        // audio or caller-receipt timestamp.
        firstTokenMs,
        schemaVersion: 2,
        turnId: parsedTrace.turnId,
        totalMs: performance.now() - startedAt,
        mode: isStreaming ? "streaming" : "non-streaming",
        sdkSessionResumeAttempted: continuityAttempted,
        sdkSessionResumed: outcome.selectedContinuity === "resume" && !outerRetryFired,
        routedVia: "agentManager",
        // KPR-323 C1: stage decomposition (adapter-side stamps + coordinator/
        // runner stamps carried on TurnResult). Log-only; all durations —
        // no content, no numbers-of-humans (repo redaction posture).
        promptBuildMs,
        sessionLookupMs,
        ...(result.stageTimings ?? {}),
        // KPR-324 C5d/S4: tool observability for T-gates and 325 pause
        // attribution. Counts + durations + server-name summary only — the
        // existing redaction posture (tool NAMES, never args, never content,
        // never the ack phrase text).
        toolCalls: result.toolCalls,
        toolMs: result.toolMs,
        toolSummary: result.toolSummary ?? "none",
        toolAckInjected: result.toolAckInjected,
        // KPR-323 C2: warm-lease markers (false/absent until Task 5 lands).
        warmPath: result.warmPath ?? false,
        ...(result.warmTurnSeq !== undefined ? { warmTurnSeq: result.warmTurnSeq } : {}),
      });
    } catch (err) {
      if (writeFailed) {
        requestOutcome = "failed";
        requestErrorClass = "sse_write_failed";
      } else if (err instanceof VoiceRequestCancelledError || requestAbort.signal.aborted) {
        requestOutcome = "cancelled";
      } else {
        requestOutcome = "failed";
        requestErrorClass = isAuthError(err) ? "engine_auth" : "spawn_failed";
      }
      if (!clientGone && !res.destroyed && !res.writableEnded && !writeFailed) {
        try {
          if (!headersSent) {
            if (sendHeaders(500, { "Content-Type": "application/json" })) {
              endResponse(JSON.stringify({ error: "Internal error" }));
            }
          } else {
            writeChunk(formatSSEDone(completionId, model, "error"), 0);
            endResponse();
          }
        } catch {
          latchWriteFailure();
        }
      }
      if (!(err instanceof VoiceRequestCancelledError)) {
        log.error("Voice spawnTurn failed", { callId, agentId, reason: String(err), bytesSent: headersSent });
      }
    } finally {
      const responseWritesSettled = await settleResponseWrites();
      if (writeFailed) {
        requestOutcome = "failed";
        requestErrorClass = "sse_write_failed";
      } else if (!responseWritesSettled) {
        requestOutcome = "incomplete";
      }
      if (writeFailed && !res.destroyed) {
        try {
          res.destroy();
        } catch {
          // A test double may omit destroy; the write failure is already latched.
        }
      }
      emitEngine(
        {
          event: "engine_terminal",
          ...(headersSent && sentStatus !== undefined ? { status: sentStatus } : {}),
          textLength: responseTextLength,
          outcome: requestOutcome,
          errorClass: requestErrorClass,
          durationMs: measure(performance.now() - startedAt, "not_observed"),
          promptBuildMs: measure(promptBuildMs, "not_reached"),
          sessionLookupMs: measure(sessionLookupMs, "not_reached"),
          firstTextMs: measure(firstTokenMs, "not_reached"),
          responseCompleteMs: measure(responseCompleteMs, "not_observed"),
          clientGone,
          correlation: parsedTrace.correlation,
          continuityAttempted,
          warm: finalResult?.warmPath ?? false,
          toolCount: finalResult?.toolCalls,
          toolMs: finalResult?.toolMs,
          toolAckInjected: finalResult?.toolAckInjected === undefined ? undefined : finalResult.toolAckInjected > 0,
          ...(finalResult?.finalMessage === "" ? { generatedAudio: "unknown" as const } : {}),
        },
        engineAttemptSeq || null,
      );
      res.off("close", onClose);
      res.off("error", onResponseError);
      res.off("finish", onFinish);
      await traceWriter.settleWrites();
    }
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
