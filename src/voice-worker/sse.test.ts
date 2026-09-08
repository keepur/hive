import { describe, expect, it } from "vitest";
import { formatSSEDone, formatSSETextChunk } from "../channels/voice/openai-translator.js";
import { SSEParser } from "./sse.js";

describe("SSEParser (KPR-322)", () => {
  it("yields one content event per delta.content", () => {
    const parser = new SSEParser();
    const events = parser.push(formatSSETextChunk("id", "Hello", "hive") + formatSSETextChunk("id", " world", "hive"));
    expect(events).toEqual([
      { kind: "content", text: "Hello" },
      { kind: "content", text: " world" },
    ]);
  });

  it("emits done on data: [DONE]", () => {
    const parser = new SSEParser();
    expect(parser.push("data: [DONE]\n\n")).toEqual([{ kind: "done", finishReason: null }]);
  });

  it("tolerates a JSON frame split across network chunks", () => {
    const parser = new SSEParser();
    expect(parser.push('data: {"choices":[{"del')).toEqual([]);
    expect(parser.push('ta":{"content":"hi"}}]}\n\n')).toEqual([{ kind: "content", text: "hi" }]);
  });

  it("formatSSEDone double-frame yields one done per frame (no coalesce)", () => {
    const parser = new SSEParser();
    const events = parser.push(formatSSEDone("id", "hive", "stop"));
    expect(events).toEqual([
      { kind: "done", finishReason: "stop" },
      { kind: "done", finishReason: null },
    ]);
  });

  it("zero-content stream (done only) yields no content events", () => {
    const parser = new SSEParser();
    const events = parser.push(formatSSEDone("id", "hive"));
    expect(events.every((e) => e.kind === "done")).toBe(true);
    expect(events.filter((e) => e.kind === "content")).toEqual([]);
  });

  it("skips malformed JSON frames", () => {
    const parser = new SSEParser();
    expect(parser.push("data: not-json\n\n")).toEqual([]);
  });
});
