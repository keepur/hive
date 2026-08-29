import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createHash, timingSafeEqual, randomUUID } from "node:crypto";
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

    // KPR-322 E2: abort the in-flight spawn when the client disconnects
    // pre-completion (LiveKit barge-in cancels the bridge's HTTP request;
    // a Vapi hang-up benefits identically). Registered BEFORE any await —
    // `close` is not replayed for late listeners, and the prompt-build /
    // session-store lookups below are real suspension points. `close` also
    // fires after a normal `end()` — `writableEnded` distinguishes premature
    // closes. All later response writes are suppressed via `clientGone`.
    let clientGone = res.destroyed === true;
    res.on("close", () => {
      if (res.writableEnded) return;
      clientGone = true;
      try {
        const abortedInFlight = agentManager.abortThread(agentId, threadId);
        log.info("Voice client disconnected mid-turn", { callId, agentId, abortedInFlight });
      } catch (err) {
        // Throw-safety (review round 1 B2): a synchronous throw in an HTTP
        // event listener is an uncaughtException — index.ts registers only
        // an unhandledRejection handler (:878) — and would crash the engine
        // mid-Vapi-coexistence. Log and swallow; the socket is gone anyway.
        log.error("abort-on-disconnect failed", { callId, agentId, error: String(err) });
      }
    });

    // Voice-specific system prompt — omits tool summaries / delegate
    // descriptions, adds call goal/context. AgentRunner consumes via
    // TurnContext.systemPromptOverride.
    const promptBuildStartedAt = Date.now(); // KPR-323 C1: T0→T1
    const systemPrompt = await buildVoiceSystemPrompt(agentConfig, this.memoryManager, {
      goal: callMeta?.goal,
      context: callMeta?.context,
    });
    const promptBuildMs = Date.now() - promptBuildStartedAt;

    const sessionStore = agentManager.getSessionStore();
    const sessionLookupStartedAt = Date.now(); // KPR-323 C1: T0→T1
    const storedRef = await sessionStore.get(agentId, threadId);
    const sessionLookupMs = Date.now() - sessionLookupStartedAt;

    // KPR-313 §3.5: provider eligibility applied at voice's OWN read — not
    // left to the spawnTurn guard. Voice chooses its prompt SHAPE from
    // resume-presence; if a mismatched-provider id flowed through and the
    // guard stripped it downstream, the turn would succeed fresh with only
    // the latest user message — a silent mid-call context loss the pre-313
    // hard failure never caused. On mismatch we treat the thread as
    // no-resume, so renderConversationPrompt fires and the full in-call
    // transcript IS voice's handoff. providerFor is the KPR-307 static-route
    // read (same resolveProviderModel as the breaker wrap); null (agent
    // vanished mid-call, SIGUSR1) degrades to no-resume — fail-soft.
    const staticProvider = agentManager.providerFor(agentId);
    const resumableId =
      storedRef && staticProvider && storedRef.provider === staticProvider ? storedRef.sessionId : undefined;

    // Choose prompt based on resume-presence (mirrors current voice behavior).
    const turnPrompt = resumableId
      ? extractLatestUserMessage(request.messages)
      : renderConversationPrompt(request.messages);
    const safePrompt = resumableId && !turnPrompt ? renderConversationPrompt(request.messages) : turnPrompt;
    const effectiveResume = resumableId && turnPrompt ? resumableId : undefined;

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
          if (!chunk || clientGone) return;
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
      // KPR-313: tag travels only when a resume is actually attempted; on a
      // provider mismatch BOTH stay unset — the full transcript above is
      // voice's handoff, and the spawnTurn guard then has nothing to trip on
      // (the voice carve-out stays annotation-free).
      sessionProvider: effectiveResume ? (staticProvider ?? undefined) : undefined,
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

    if (clientGone) {
      log.info("Voice turn skipped — client disconnected before spawn", { callId, agentId });
      return;
    }

    let outcome = await runOnce(ctx);
    let outerRetryFired = false;

    // Outer retry — resume failed before any bytes hit the wire. Restart with
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
    if (!outcome.ok && !outcome.circuitOpen && effectiveResume && !outcome.bytesSent && !clientGone) {
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

    // E2: never write into a dead socket — the turn (aborted or completed)
    // ends silently; next turn's resume either works or trips the outer
    // full-transcript retry (recoverable by construction, spec §7).
    if (clientGone) {
      log.info("Voice turn ended after client disconnect — response suppressed", {
        callId,
        agentId,
        ok: outcome.ok,
        aborted: outcome.ok ? (outcome.result.aborted ?? false) : undefined,
      });
      return;
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
