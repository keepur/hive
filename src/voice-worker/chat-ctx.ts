/** OpenAI-shape message for the bridge request body. Import-free. */
export interface BridgeMessage {
  role: "user" | "assistant";
  content: string;
}

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
}

/**
 * Serialize the session transcript to the bridge messages array.
 * Full transcript every turn — the engine's outer retry re-renders the
 * ENTIRE array when a stale SDK session fails; a delta-only sender would
 * break crash recovery (§5.2). No system message: the engine drops them
 * (conversation-prompt.ts) and owns prompt authority (§5.3).
 */
export function serializeTranscript(turns: TranscriptTurn[]): BridgeMessage[] {
  return turns.filter((t) => t.text.trim().length > 0).map((t) => ({ role: t.role, content: t.text }));
}
