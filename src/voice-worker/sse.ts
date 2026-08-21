/** Incremental OpenAI-compatible SSE parser (KPR-322 §5.4). Import-free. */
export type SSEEvent = { kind: "content"; text: string } | { kind: "done"; finishReason: string | null };

export class SSEParser {
  private buffer = "";

  /** Feed one network chunk; returns zero or more complete events, in order. */
  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const events: SSEEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf("\n\n")) !== -1) {
      const frame = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);
      for (const line of frame.split("\n")) {
        if (!line.startsWith("data: ")) continue;
        const data = line.slice(6).trim();
        if (data === "[DONE]") {
          events.push({ kind: "done", finishReason: null });
          continue;
        }
        try {
          const parsed = JSON.parse(data) as {
            choices?: Array<{ delta?: { content?: string }; finish_reason?: string | null }>;
          };
          const choice = parsed.choices?.[0];
          const text = choice?.delta?.content;
          if (typeof text === "string" && text.length > 0) {
            events.push({ kind: "content", text });
          } else if (choice?.finish_reason) {
            events.push({ kind: "done", finishReason: choice.finish_reason });
          }
        } catch {
          // Malformed frame: skip — the engine only emits well-formed frames;
          // a truncated tail stays in the buffer until its terminator arrives.
        }
      }
    }
    return events;
  }
}
