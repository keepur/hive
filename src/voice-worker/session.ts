/**
 * Per-call session orchestration (KPR-322 §3/§4/§7/§8).
 * - builds STT/TTS/VAD per vendor cell (S7)
 * - outbound: creates the SIP participant (waitUntilAnswered) then triggers
 *   the first generation (empty user transcript → engine's greet branch)
 * - barge-in bookkeeping: records the actually-spoken prefix for the
 *   next-turn interruption marker
 * - §8 failure rows via error-map (retry/speak/end-call)
 *
 * NOTE (Task-0 pin, agents-js 1.6.4):
 * - Import DispatchMetadata from `./dispatch-meta.js` (not `./main.js`) — Task 5
 *   split that type to avoid a session↔entry cycle.
 * - `agent_speech_interrupted` does not exist on AgentSessionEventTypes.
 *   Spoken-prefix barge-in is wired via `conversation_item_added`: an assistant
 *   ChatMessage with `interrupted === true` carries `textContent` equal to the
 *   forwarded (actually-spoken) prefix (agent_activity commits that message
 *   from `forwardedText`). SpeechHandle has `interrupted` + `chatItems` but no
 *   spoken-prefix field of its own; `overlapping_speech` is audio-overlap
 *   detection (probability/duration) and does not carry text. So
 *   conversation_item_added is the 1.6.4 surface that actually holds the prefix.
 * - `session.on` is typed against AgentSessionEventTypes (string enum), so
 *   listeners use `voice.AgentSessionEventTypes.ConversationItemAdded` /
 *   `.Error` (values still `"conversation_item_added"` / `"error"`). The
 *   Error callback receives ErrorEvent `{ type:"error", error: LLMError|… }`,
 *   not a raw Error. Unwrap BridgeError from `ev.error.type === "llm_error" &&
 *   ev.error.error instanceof BridgeError`. HiveLLM `run()` throws are swallowed
 *   by LLMStream `startSoon` after `llm.emit("error")`; the session forwards that
 *   as ErrorEvent.
 * - `session.say` / `generateReply` return SpeechHandle, not Promise. Terminal
 *   and retry `sayFirst` lines use `handle.waitForPlayout()` before shutdown /
 *   delay. Do not invent `outputOptions.transformText` — `start()` takes room
 *   audio/transcription flags. Hive `normalizeForTTS` is a constructor
 *   `ttsTextTransforms` custom TextTransform (plus builtin filter_markdown /
 *   filter_emoji).
 * - Prefer `turnHandling: { turnDetection: "stt" | "vad" }` (non-deprecated).
 * - Inbound called-number: LiveKit SIP attribute `sip.trunkPhoneNumber`
 *   (protocol AttrSIPTrunkNumber). No JS constant in agents 1.6.4 / rtc-node.
 */
import {
  voice,
  type ConversationItemAddedEvent,
  type ErrorEvent,
  type JobContext,
  type MetricsCollectedEvent,
  type SpeechCreatedEvent,
  type UserInputTranscribedEvent,
  type UserStateChangedEvent,
} from "@livekit/agents";
import * as cartesia from "@livekit/agents-plugin-cartesia";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as silero from "@livekit/agents-plugin-silero";
import { SipClient } from "livekit-server-sdk";
import { RoomEvent, type RemoteParticipant } from "@livekit/rtc-node";
import { ReadableStream, TransformStream } from "node:stream/web";
import { createLogger } from "../logging/logger.js";
import type { VendorCell } from "./cells.js";
import type { DispatchMetadata } from "./dispatch-meta.js";
import { FAILURE_BEHAVIOR, FALLBACK_LINES, resolveFailureAction } from "./error-map.js";
import { BridgeError, HiveLLM } from "./hive-llm.js";
import { SpeechTrace, type CallDiagnosticCounts } from "./speech-trace.js";
import { StartupActionOwnership, StartupArbiter, type RecoveryChain, type StartupEvent } from "./startup-arbiter.js";
import { CallStats, type VoiceWorkerHeartbeat } from "./telemetry.js";
import { TracedAgent } from "./traced-agent.js";
import { VOICE_PROCESS_ID } from "../voice/voice-trace.js";
import { normalizeForTTS } from "./tts-normalize.js";
import type { WorkerConfig } from "./worker-config.js";

const log = createLogger("voice-worker-session");

/** LiveKit SIP inbound called-number attribute (protocol AttrSIPTrunkNumber). */
const SIP_TRUNK_PHONE_NUMBER_ATTR = "sip.trunkPhoneNumber";

export function buildStt(cell: VendorCell, deepgramApiKey: string) {
  return cell.stt === "deepgram/flux-general-en"
    ? new deepgram.STTv2({ model: "flux-general-en", apiKey: deepgramApiKey })
    : new deepgram.STT({ model: "nova-3", apiKey: deepgramApiKey });
}

export function buildTts(cell: VendorCell, wc: WorkerConfig, agentId: string) {
  const voiceId = wc.agentVoices[agentId];
  return cell.tts === "cartesia/sonic-3"
    ? new cartesia.TTS({
        model: "sonic-3",
        apiKey: wc.cartesiaApiKey,
        ...(typeof voiceId === "string" && voiceId ? { voice: voiceId } : {}),
      })
    : new elevenlabs.TTS({ model: "eleven_flash_v2_5", apiKey: wc.elevenlabsApiKey });
}

/** Map each TTS text chunk through hive's light markdown strip. */
function hiveTtsNormalize(stream: ReadableStream<string>): ReadableStream<string> {
  return stream.pipeThrough(
    new TransformStream<string, string>({
      transform(chunk, controller) {
        controller.enqueue(normalizeForTTS(chunk));
      },
    }),
  );
}

/** Pure: inbound agent resolution (SIP-3). Exported for unit tests. */
export function resolveInboundAgent(
  calledNumber: string | undefined,
  inboundAgents: Record<string, string>,
): { agentId: string; goal: string; context: string } | null {
  if (!calledNumber) return null;
  // Epic-integration review round 1 (mechanical): own-property guard — the
  // called number is telephony-supplied (SIP "To"), and a plain indexed
  // lookup would let a key like "constructor" resolve Object's constructor
  // function off the prototype chain instead of returning null for a
  // genuinely-unmapped number. Mirrors the pattern in provider-registry.ts /
  // tool-transport.ts (KPR-407).
  if (!Object.prototype.hasOwnProperty.call(inboundAgents, calledNumber)) return null;
  const agentId = inboundAgents[calledNumber];
  if (!agentId) return null;
  return {
    agentId,
    goal: "Answer this inbound vendor callback professionally and help the caller.",
    context: "Inbound call to the hive ops line (vendor callback).",
  };
}

/** Ordered job teardown so noteCallEnded hits a live Mongo client (KPR-322). */
export async function runJobShutdown(hooks: {
  releaseCall: () => Promise<void>;
  closeTrace?: () => void;
  settleTrace?: () => Promise<unknown>;
  snapshotTrace?: () => CallDiagnosticCounts;
  flush: (diagnostics?: CallDiagnosticCounts) => Promise<unknown>;
  closeMongo: () => Promise<void>;
}): Promise<void> {
  try {
    hooks.closeTrace?.();
  } catch {
    // Continue teardown: later persistence and resource release are independent.
  }
  await hooks.settleTrace?.().catch(() => {});
  let diagnostics: CallDiagnosticCounts | undefined;
  try {
    diagnostics = hooks.snapshotTrace?.();
  } catch {
    // A missing snapshot must not strand heartbeat or Mongo cleanup.
  }
  await hooks.releaseCall().catch(() => {});
  await hooks.flush(diagnostics).catch(() => {});
  await hooks.closeMongo().catch(() => {});
}

export async function runCallSession(
  ctx: JobContext,
  wc: WorkerConfig,
  meta: DispatchMetadata,
  cell: VendorCell,
  heartbeat?: VoiceWorkerHeartbeat,
  closeMongo?: () => Promise<void>,
): Promise<void> {
  const shutdownHooks: Parameters<typeof runJobShutdown>[0] = {
    releaseCall: async () => {},
    flush: async (_diagnostics?: CallDiagnosticCounts) => {},
    closeMongo: closeMongo ?? (async () => {}),
  };
  ctx.addShutdownCallback(() => runJobShutdown(shutdownHooks));

  await ctx.connect();
  const callId = ctx.room.name;
  if (!callId) {
    log.error("Job room has no name — rejecting");
    ctx.shutdown();
    return;
  }
  const dest = meta.to;
  const outbound = !!dest;

  let hiveAgentId = meta.hive_agent_id ?? "";
  let goal = meta.goal ?? "";
  let context = meta.context ?? "";
  if (!outbound) {
    const called = inboundCalledNumber(ctx);
    const resolved = resolveInboundAgent(called, wc.inboundAgents);
    if (!resolved) {
      log.error("Inbound call with no inboundAgents mapping — rejecting", { callId });
      ctx.shutdown();
      return;
    }
    ({ agentId: hiveAgentId, goal, context } = resolved);
  }

  const speechTrace = new SpeechTrace({ callId, workerBootId: VOICE_PROCESS_ID });
  const callAbort = new AbortController();
  const hiveLLM = new HiveLLM({
    bridgeUrl: wc.bridgeUrl,
    bridgeToken: wc.bridgeToken,
    hiveAgentId,
    callId,
    goal,
    context,
    trace: speechTrace,
    callSignal: callAbort.signal,
  });

  const ttsProvider = buildTts(cell, wc, hiveAgentId);
  const vad = await silero.VAD.load();
  const session = new voice.AgentSession({
    stt: buildStt(cell, wc.deepgramApiKey),
    tts: ttsProvider,
    vad,
    llm: hiveLLM,
    turnHandling: { turnDetection: cell.stt === "deepgram/flux-general-en" ? "stt" : "vad" },
    ttsTextTransforms: ["filter_markdown", "filter_emoji", hiveTtsNormalize],
  });

  const stats = new CallStats(
    wc,
    {
      callId,
      agentId: hiveAgentId,
      cell,
      direction: outbound ? "outbound" : "inbound",
    },
    (status, reason) => speechTrace.summaryPersistence(status, reason),
  );
  const intendedIdentity = outbound ? `sip-${callId}` : undefined;
  const inputOptions: { audioEnabled: boolean; participantIdentity?: string } = {
    audioEnabled: true,
    ...(intendedIdentity ? { participantIdentity: intendedIdentity } : {}),
  };
  const outputOptions = { audioEnabled: true };

  let closeCall: (cause: "call_close" | "setup_failed") => Promise<void> = async () => {};
  // Assigned immediately after the arbiter; its request callback closes over this exact call-local owner.
  // eslint-disable-next-line prefer-const
  let ownership!: StartupActionOwnership<BridgeError>;
  const arbiter = new StartupArbiter({
    requestOpening: () => {
      try {
        return ownership.scheduleOwned("opening", () => session.generateReply());
      } catch (error) {
        void closeCall("setup_failed");
        throw error;
      }
    },
    observe: (event) => observeStartup(speechTrace, event),
  });

  ownership = new StartupActionOwnership<BridgeError>({
    arbiter,
    trace: speechTrace,
    recover: async (chain, failure, actions) => {
      await performOwnedRecovery(chain, failure, actions, { session, stats, ctx, heartbeat });
    },
  });

  const agent = new TracedAgent({
    // §5.3: intentionally unused — the ENGINE owns the prompt
    // (buildVoiceSystemPrompt via TurnContext.systemPromptOverride).
    instructions: "Placeholder — hive owns the prompt server-side.",
    tts: ttsProvider,
    callId,
    workerBootId: VOICE_PROCESS_ID,
    callSignal: callAbort.signal,
    trace: speechTrace,
    onAcceptedUserTurn: () => {
      if (callAbort.signal.aborted) return;
      const acceptedEpoch = ownership.acceptCallerTurn();
      speechTrace.call({ event: "caller_turn_accepted", acceptedEpoch });
    },
  });

  let traceClosed = false;
  const closeTrace = (cause: "call_closed" | "setup_failed") => {
    if (traceClosed) return;
    traceClosed = true;
    if (!callAbort.signal.aborted) callAbort.abort();
    agent.dispose();
    speechTrace.close(cause);
  };

  if (heartbeat) void heartbeat.noteCallStarted();
  let callReleased = false;
  const releaseCall = async () => {
    if (callReleased) return;
    callReleased = true;
    if (!heartbeat) return;
    await heartbeat.noteCallEnded();
  };
  shutdownHooks.releaseCall = releaseCall;
  shutdownHooks.closeTrace = () => closeTrace("call_closed");
  shutdownHooks.settleTrace = () => speechTrace.settleWrites();
  shutdownHooks.snapshotTrace = () => speechTrace.snapshot();
  shutdownHooks.flush = (diagnostics) => stats.flush("completed", diagnostics);

  const onSpeechCreated = (ev: SpeechCreatedEvent) => {
    const scope = ownership.generationScope;
    speechTrace.speechCreated(ev.speechHandle, scope?.origin ?? "sdk_response", scope?.epoch ?? arbiter.epoch);
    ownership.registerSpeech(ev.speechHandle);
  };
  const onMetrics = (ev: MetricsCollectedEvent) => {
    speechTrace.metrics(ev);
    if (ev.metrics.type === "eou_metrics" && ev.metrics.speechId) ownership.admitEou(ev.metrics.speechId);
  };
  const onUserInput = (ev: UserInputTranscribedEvent) => {
    const hasNonemptyFinal = ev.isFinal && !!ev.transcript.trim();
    if (hasNonemptyFinal) speechTrace.call({ event: "caller_final_input", hasFinalInput: true });
    arbiter.finalInput(hasNonemptyFinal);
  };
  const onUserState = (ev: UserStateChangedEvent) => {
    speechTrace.call({ event: "caller_state", state: ev.newState });
    if (outbound) arbiter.callerState(ev.newState);
  };
  const onConversationItem = (ev: ConversationItemAddedEvent) => {
    const item = ev.item;
    if (item.type === "message" && item.role === "assistant" && item.interrupted) {
      hiveLLM.interruptedSpokenText = item.textContent ?? "";
    }
  };
  const onSessionError = (ev: ErrorEvent) => {
    const failure = bridgeFailure(ev);
    if (!failure) {
      if (ev.error.type === "llm_error") {
        speechTrace.unboundProviderFailure("llm", "llm_provider_failed");
      } else if (ev.error.type === "tts_error") {
        speechTrace.unboundProviderFailure("tts", "tts_provider_failed");
      }
      log.error("Session error (non-bridge)", { callId, error: "provider_error" });
      return;
    }
    if (ownership.captureError(failure)) {
      stats.recordFailure(FAILURE_BEHAVIOR[failure.failureClass].telemetryOutcome);
    }
  };
  const onSessionClose = () => {
    void closeCall("call_close");
  };
  const onParticipantConnected = (participant: RemoteParticipant) => {
    if (participant.identity === intendedIdentity) {
      speechTrace.call({ event: "participant_available", intendedParticipant: true });
    }
  };
  const onParticipantDisconnected = (participant: RemoteParticipant) => {
    if (intendedIdentity && participant.identity === intendedIdentity) void closeCall("call_close");
  };
  const onRoomDisconnected = () => {
    void closeCall("call_close");
  };

  session.on(voice.AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
  session.on(voice.AgentSessionEventTypes.MetricsCollected, onMetrics);
  session.on(voice.AgentSessionEventTypes.UserInputTranscribed, onUserInput);
  session.on(voice.AgentSessionEventTypes.UserStateChanged, onUserState);
  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, onConversationItem);
  session.on(voice.AgentSessionEventTypes.Error, onSessionError);
  session.on(voice.AgentSessionEventTypes.Close, onSessionClose);
  ctx.room.on(RoomEvent.ParticipantConnected, onParticipantConnected);
  ctx.room.on(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
  ctx.room.on(RoomEvent.Disconnected, onRoomDisconnected);

  let callClosedResolve!: () => void;
  const callClosed = new Promise<void>((resolve) => {
    callClosedResolve = resolve;
  });
  let startSettled = false;
  let sdkCloseInFlight: Promise<void> | null = null;
  let sdkCloseEpoch = -1;
  let cleanupPromise: Promise<void> | null = null;

  const detachListeners = () => {
    session.off(voice.AgentSessionEventTypes.SpeechCreated, onSpeechCreated);
    session.off(voice.AgentSessionEventTypes.MetricsCollected, onMetrics);
    session.off(voice.AgentSessionEventTypes.UserInputTranscribed, onUserInput);
    session.off(voice.AgentSessionEventTypes.UserStateChanged, onUserState);
    session.off(voice.AgentSessionEventTypes.ConversationItemAdded, onConversationItem);
    session.off(voice.AgentSessionEventTypes.Error, onSessionError);
    session.off(voice.AgentSessionEventTypes.Close, onSessionClose);
    ctx.room.off(RoomEvent.ParticipantConnected, onParticipantConnected);
    ctx.room.off(RoomEvent.ParticipantDisconnected, onParticipantDisconnected);
    ctx.room.off(RoomEvent.Disconnected, onRoomDisconnected);
  };
  const disableMedia = () => {
    inputOptions.audioEnabled = false;
    outputOptions.audioEnabled = false;
    try {
      session.input.setAudioEnabled(false);
    } catch {}
    try {
      session.output.setAudioEnabled(false);
      session.output.audio?.clearBuffer();
    } catch {}
  };
  const closeSdkAgain = (): Promise<void> => {
    const epoch = startSettled ? 1 : 0;
    const previous = sdkCloseInFlight;
    if (previous && sdkCloseEpoch < epoch) return previous.catch(() => {}).then(() => closeSdkAgain());
    if (previous) return previous;
    const task = Promise.resolve().then(() => session.close());
    sdkCloseEpoch = epoch;
    sdkCloseInFlight = task;
    void task
      .finally(() => {
        if (sdkCloseInFlight === task) sdkCloseInFlight = null;
      })
      .catch(() => {});
    return task;
  };
  const closeSdkBounded = async (reason: "call_close" | "late_start" | "late_start_failed") => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const result = await Promise.race([
        closeSdkAgain().then(
          () => "closed" as const,
          () => "failed" as const,
        ),
        new Promise<"timeout">((resolve) => {
          timer = setTimeout(() => resolve("timeout"), 2_000);
        }),
      ]);
      speechTrace.teardown(result, reason);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };
  closeCall = (cause) => {
    if (!arbiter.closed) {
      if (!startSettled) speechTrace.startupPending();
      arbiter.close();
      ownership.close();
      disableMedia();
      if (!callAbort.signal.aborted) callAbort.abort();
      callClosedResolve();
      speechTrace.call({ event: "call_closed", reason: cause });
      closeTrace(cause === "setup_failed" ? "setup_failed" : "call_closed");
      detachListeners();
    }
    cleanupPromise ??= closeSdkBounded("call_close");
    return cleanupPromise;
  };
  shutdownHooks.closeTrace = () => {
    void closeCall("call_close");
  };
  shutdownHooks.settleTrace = async () => {
    await closeCall("call_close").catch(() => {});
    return speechTrace.settleWrites();
  };

  speechTrace.call({ event: "call_started", direction: outbound ? "outbound" : "inbound" });

  try {
    const startTask = session.start({ agent, room: ctx.room, inputOptions, outputOptions });
    const observedStart = startTask.then(
      async () => {
        startSettled = true;
        if (arbiter.closed) await closeSdkBounded("late_start");
      },
      async (error) => {
        startSettled = true;
        if (arbiter.closed) await closeSdkBounded("late_start_failed");
        throw error;
      },
    );
    void observedStart.catch(() => {});
    await Promise.race([observedStart, callClosed]);
    if (arbiter.closed) return;
    await observedStart;
    speechTrace.call({ event: "session_started" });

    if (dest) {
      if (arbiter.closed) return;
      const sip = new SipClient(wc.livekitUrl, wc.livekitApiKey, wc.livekitApiSecret);
      await sip.createSipParticipant(wc.sipTrunkId, dest, callId, {
        participantIdentity: intendedIdentity!,
        waitUntilAnswered: true,
      });
      if (arbiter.closed) return;
      speechTrace.call({ event: "sip_answered", intendedParticipant: true });
      arbiter.answer();
    }
  } catch (err) {
    // callId only — LiveKit/SIP errors can embed the destination.
    log.error("Call setup failed", { callId });
    stats.recordFailure("setup_failed");
    stats.recordTerminalOutcome("failed");
    await closeCall("setup_failed");
    await speechTrace.settleWrites().catch(() => {});
    if (heartbeat) await heartbeat.noteError("setup_failed");
    await stats.flush("failed", speechTrace.snapshot());
    throw err;
  }
}

/** First-wins setup failure so shutdown flush("completed") cannot win. */
export async function recordSetupFailure(
  stats: Pick<CallStats, "recordFailure" | "flush">,
  heartbeat?: Pick<VoiceWorkerHeartbeat, "noteError">,
  diagnostics?: CallDiagnosticCounts,
): Promise<void> {
  stats.recordFailure("setup_failed");
  if (heartbeat) await heartbeat.noteError("setup_failed");
  await stats.flush("failed", diagnostics);
}

function bridgeFailure(ev: ErrorEvent): BridgeError | null {
  const inner = ev.error;
  return inner.type === "llm_error" && inner.error instanceof BridgeError ? inner.error : null;
}

function observeStartup(trace: SpeechTrace, event: StartupEvent): void {
  if (event.kind === "decision") {
    trace.call({ event: "opening_decision", decision: event.decision, reason: event.reason });
  } else if (event.kind === "cancel") {
    trace.markCancellation(event.speechId, event.reason);
  }
}

async function performOwnedRecovery(
  chain: RecoveryChain<BridgeError>,
  failure: BridgeError,
  actions: StartupActionOwnership<BridgeError>,
  args: {
    session: voice.AgentSession;
    stats: CallStats;
    ctx: JobContext;
    heartbeat?: VoiceWorkerHeartbeat;
  },
): Promise<void> {
  const { session, stats, ctx, heartbeat } = args;
  if (!actions.chainOwns(chain)) return;
  const behavior = FAILURE_BEHAVIOR[failure.failureClass];
  const retrySpent = behavior.retryOnce ? stats.retryConsumed(failure.failureClass) : true;
  const action = resolveFailureAction(failure.failureClass, retrySpent);
  if (action.kind === "retry") {
    if (action.sayFirst) {
      if (!actions.chainOwns(chain)) return;
      const fallback = actions.scheduleOwned("fallback", () => session.say(FALLBACK_LINES[action.sayFirst!]), chain);
      try {
        await actions.waitOwned(chain, () => fallback.waitForPlayout());
      } catch {
        // Best-effort fallback failure never authorizes an additional retry.
      }
    }
    if (!actions.chainOwns(chain)) return;
    if (action.delayMs > 0 && !(await actions.delayOwned(chain, action.delayMs))) return;
    if (!actions.chainOwns(chain)) return;
    actions.scheduleOwned("retry", () => session.generateReply(), chain);
    return;
  }
  if (action.kind === "continue") return;
  if (!actions.chainOwns(chain)) return;
  stats.recordTerminalOutcome("failed");
  const fallback = actions.scheduleOwned("fallback", () => session.say(FALLBACK_LINES[action.say]), chain);
  try {
    await actions.waitOwned(chain, () => fallback.waitForPlayout());
  } catch {
    // Terminal fallback is best effort; shutdown still requires current ownership.
  }
  if (!actions.chainOwns(chain)) return;
  if (heartbeat) void heartbeat.noteError(behavior.telemetryOutcome);
  ctx.shutdown();
}

function inboundCalledNumber(ctx: JobContext): string | undefined {
  for (const p of ctx.room.remoteParticipants.values()) {
    const attr = p.attributes?.[SIP_TRUNK_PHONE_NUMBER_ATTR];
    if (attr) return attr;
  }
  return undefined;
}
