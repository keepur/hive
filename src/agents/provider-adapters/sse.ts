/**
 * KPR-391 (§4.3): generic SSE FRAMING — event-boundary splitting, field
 * parsing, and the Responses-style `[DONE]` sentinel — extracted from the
 * codex adapter because KPR-392's grok shares the same framing, via its
 * OpenAI-format chat-completions endpoint (grok has spoken directly to xAI,
 * with no intermediary, since KPR-410). Provider-specific event APPLICATION
 * (what a `response.*` / `interaction.*` payload means) stays in each
 * adapter.
 */

export interface SseEvent {
  event?: string;
  data: string;
}

/**
 * Split a buffered, byte-decoded SSE string on blank-line event boundaries.
 * The trailing partial event (no terminating blank line yet) is returned as
 * `remainder` for the caller to re-buffer.
 */
export function splitSseEvents(buffer: string): { events: string[]; remainder: string } {
  const parts = buffer.split(/\r?\n\r?\n/);
  const remainder = parts.pop() ?? "";
  return { events: parts, remainder };
}

/** Parse one raw SSE event block into {event?, data}. Comment lines (`:`) and
 *  empty lines are skipped; multiple data: lines join with `\n`. Returns null
 *  when the block carries no data lines. */
export function parseSseEvent(raw: string): SseEvent | null {
  let event: string | undefined;
  const data: string[] = [];

  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    if (line.startsWith("event:")) {
      event = line.slice("event:".length).trim();
      continue;
    }
    if (line.startsWith("data:")) {
      data.push(line.slice("data:".length).trimStart());
    }
  }

  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

/** The OpenAI-format stream-terminator sentinel frame. */
export function isSseDone(event: SseEvent): boolean {
  return event.data === "[DONE]";
}
