/**
 * KPR-324 C1/S2: hive-side tool-start acknowledgment for voice turns.
 *
 * When a voice-channel spawn loop observes a `tool_use` block and the model
 * produced no spoken text in the current segment (turn-start → this
 * boundary, or previous boundary → this one — spec §4.1), the caller injects
 * one canned phrase through the existing `onStream` SSE path so the caller
 * hears something before the tool-run silence. The phrase is NEVER written
 * into the SDK session transcript (spec §4.1 "do not insert into history").
 *
 * Pure module: no I/O, no logging, no config read — both spawn loops
 * (AgentRunner.send cold, WarmVoiceSession.consumeOneTurn warm) pass
 * `enabled` from config.voice.toolAck and their own channel/stream facts.
 *
 * Rotation state is CALLER-OWNED and per-turn (spec §4.2): each spawn-loop
 * iteration keeps its own `{ index }` local, so concurrent calls never
 * skip/collide phrases. Do not add a module-level counter.
 */

/**
 * Phone-native phrase set (spec §4.2): constants, not config. Delivery may
 * retune wording without a spec amendment; 325 may persona-split later.
 * No markdown, no "as an AI" — normalizeForTTS passes these through as-is.
 */
export const VOICE_TOOL_ACK_PHRASES: readonly string[] = [
  "One moment.",
  "Let me check that.",
  "Hang on, I'll look that up.",
];

/**
 * Single separator appended by CALL SITES (not part of the phrase constants):
 * SSE `delta.content` chunks concatenate verbatim downstream, so without it
 * the ack would fuse with the model's post-tool sentence ("moment.The
 * status…") and defeat TTS sentence splitting. Wording-latitude ruling
 * (spec §4.2, "delivery may retune") covers this one-space addition.
 */
export const VOICE_TOOL_ACK_SEPARATOR = " ";

export interface ToolAckGateArgs {
  /** config.voice.toolAck.enabled — the S7 rollback lever. */
  enabled: boolean;
  /** True iff any assistant text was streamed/emitted in the current segment. */
  streamedThisSegment: boolean;
  /** True iff the loop has an onStream callback to speak through. Necessary but NOT sufficient (spec §4.3). */
  hasOnStream: boolean;
  /** Cold: WorkItemContext.channelKind; warm: the lease's channel (always "voice"). The load-bearing gate. */
  channel: string;
}

/** Spec §4.1 gate: inject iff enabled ∧ silent segment ∧ streamable ∧ voice. */
export function shouldInjectToolAck(args: ToolAckGateArgs): boolean {
  return args.enabled && !args.streamedThisSegment && args.hasOnStream && args.channel === "voice";
}

/** Caller-owned per-turn rotation state (starts at 0 each send/consumeOneTurn). */
export interface AckRotationState {
  index: number;
}

/**
 * Next phrase in rotation, wrapping. Pure: returns the phrase and the NEW
 * index; the caller reassigns its local state (spec §4.3 signature).
 */
export function nextAckPhrase(state: AckRotationState): { phrase: string; index: number } {
  const phrase = VOICE_TOOL_ACK_PHRASES[state.index % VOICE_TOOL_ACK_PHRASES.length]!;
  return { phrase, index: state.index + 1 };
}
