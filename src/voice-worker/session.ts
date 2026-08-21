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
import { voice, type ErrorEvent, type JobContext } from "@livekit/agents";
import * as cartesia from "@livekit/agents-plugin-cartesia";
import * as deepgram from "@livekit/agents-plugin-deepgram";
import * as elevenlabs from "@livekit/agents-plugin-elevenlabs";
import * as silero from "@livekit/agents-plugin-silero";
import { SipClient } from "livekit-server-sdk";
import { ReadableStream, TransformStream } from "node:stream/web";
import { createLogger } from "../logging/logger.js";
import type { VendorCell } from "./cells.js";
import type { DispatchMetadata } from "./dispatch-meta.js";
import { FAILURE_BEHAVIOR, FALLBACK_LINES, resolveFailureAction } from "./error-map.js";
import { BridgeError, HiveLLM } from "./hive-llm.js";
import { CallStats, TurnMetrics, type VoiceWorkerHeartbeat } from "./telemetry.js";
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

export function buildTts(cell: VendorCell, wc: WorkerConfig) {
  return cell.tts === "cartesia/sonic-3"
    ? new cartesia.TTS({ model: "sonic-3", apiKey: wc.cartesiaApiKey })
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
  const agentId = inboundAgents[calledNumber];
  if (!agentId) return null;
  return {
    agentId,
    goal: "Answer this inbound vendor callback professionally and help the caller.",
    context: "Inbound call to the DodiHome ops line (vendor callback).",
  };
}

export async function runCallSession(
  ctx: JobContext,
  wc: WorkerConfig,
  meta: DispatchMetadata,
  cell: VendorCell,
  heartbeat?: VoiceWorkerHeartbeat,
): Promise<void> {
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

  const hiveLLM = new HiveLLM({
    bridgeUrl: wc.bridgeUrl,
    bridgeToken: wc.bridgeToken,
    hiveAgentId,
    callId,
    goal,
    context,
  });

  const vad = await silero.VAD.load();
  const session = new voice.AgentSession({
    stt: buildStt(cell, wc.deepgramApiKey),
    tts: buildTts(cell, wc),
    vad,
    llm: hiveLLM,
    turnHandling: { turnDetection: cell.stt === "deepgram/flux-general-en" ? "stt" : "vad" },
    ttsTextTransforms: ["filter_markdown", "filter_emoji", hiveTtsNormalize],
  });

  const stats = new CallStats(wc, {
    callId,
    agentId: hiveAgentId,
    cell,
    direction: outbound ? "outbound" : "inbound",
  });
  const metrics = new TurnMetrics(callId, cell, hiveLLM, outbound ? "outbound" : "inbound", (line) => {
    if (line.totalToFirstAudioMs >= 0) stats.recordTurnLatency(line.totalToFirstAudioMs);
  });
  metrics.attach(session);

  if (heartbeat) void heartbeat.noteCallStarted();
  let callReleased = false;
  const releaseCall = () => {
    if (callReleased) return;
    callReleased = true;
    if (!heartbeat) return;
    void heartbeat.noteCallEnded();
  };

  session.on(voice.AgentSessionEventTypes.ConversationItemAdded, (ev) => {
    const item = ev.item;
    if (item.type === "message" && item.role === "assistant" && item.interrupted) {
      hiveLLM.interruptedSpokenText = item.textContent ?? "";
      stats.recordInterruption();
    }
  });

  session.on(voice.AgentSessionEventTypes.Error, (ev) => {
    void handleSessionError(ev, { session, stats, ctx, callId, heartbeat, releaseCall });
  });

  ctx.addShutdownCallback(() => {
    releaseCall();
    return stats.flush("completed");
  });

  const agent = new voice.Agent({
    // §5.3: intentionally unused — the ENGINE owns the prompt
    // (buildVoiceSystemPrompt via TurnContext.systemPromptOverride). Do not
    // "fix" agent behavior here.
    instructions: "Placeholder — hive owns the prompt server-side.",
  });
  try {
    await session.start({ agent, room: ctx.room });

    if (dest) {
      const sip = new SipClient(wc.livekitUrl, wc.livekitApiKey, wc.livekitApiSecret);
      await sip.createSipParticipant(wc.sipTrunkId, dest, callId, {
        participantIdentity: `sip-${callId}`,
        waitUntilAnswered: true,
      });
      session.generateReply();
    }
  } catch (err) {
    // callId only — LiveKit/SIP errors can embed the destination.
    log.error("Call setup failed", { callId });
    await recordSetupFailure(stats, heartbeat);
    throw err;
  }
}

/** First-wins setup failure so shutdown flush("completed") cannot win. */
export async function recordSetupFailure(
  stats: Pick<CallStats, "recordFailure" | "flush">,
  heartbeat?: Pick<VoiceWorkerHeartbeat, "noteError">,
): Promise<void> {
  stats.recordFailure("setup_failed");
  if (heartbeat) await heartbeat.noteError("setup_failed");
  await stats.flush("failed");
}

async function handleSessionError(
  ev: ErrorEvent,
  args: {
    session: voice.AgentSession;
    stats: CallStats;
    ctx: JobContext;
    callId: string;
    heartbeat?: VoiceWorkerHeartbeat;
    releaseCall: () => void;
  },
): Promise<void> {
  const { session, stats, ctx, callId, heartbeat, releaseCall } = args;
  const inner = ev.error;
  const failure = inner.type === "llm_error" && inner.error instanceof BridgeError ? inner.error : null;
  if (!failure) {
    log.error("Session error (non-bridge)", { callId, error: String("error" in inner ? inner.error : inner) });
    return;
  }
  const behavior = FAILURE_BEHAVIOR[failure.failureClass];
  stats.recordFailure(behavior.telemetryOutcome);
  const retrySpent = behavior.retryOnce ? stats.retryConsumed(failure.failureClass) : true;
  const action = resolveFailureAction(failure.failureClass, retrySpent);
  if (action.kind === "retry") {
    if (action.sayFirst) await speakAndWait(session, FALLBACK_LINES[action.sayFirst]);
    if (action.delayMs > 0) await new Promise((r) => setTimeout(r, action.delayMs));
    session.generateReply();
    return;
  }
  if (action.kind === "continue") return;
  await speakAndWait(session, FALLBACK_LINES[action.say]);
  if (heartbeat) void heartbeat.noteError(behavior.telemetryOutcome);
  await stats.flush("failed");
  releaseCall();
  ctx.shutdown();
}

async function speakAndWait(session: voice.AgentSession, text: string): Promise<void> {
  try {
    await session.say(text).waitForPlayout();
  } catch {
    // Fallback TTS is best-effort; still proceed with retry/shutdown.
  }
}

function inboundCalledNumber(ctx: JobContext): string | undefined {
  for (const p of ctx.room.remoteParticipants.values()) {
    const attr = p.attributes?.[SIP_TRUNK_PHONE_NUMBER_ATTR];
    if (attr) return attr;
  }
  return undefined;
}
