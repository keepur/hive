import { describe, expect, it } from "vitest";
import { BENCH_SCRIPT, SseChunkParser, assertTurn, buildBridgeRequest, benchResultRow } from "./voice-bench-script.js";
import { formatSSEDone, formatSSETextChunk } from "../channels/voice/openai-translator.js";

describe("bench script (KPR-465 §6.1)", () => {
  it("has the fixed shape: 10 turns, two barge-ins, two tool turns, one recall, expectations on every non-greeting turn, no personal data", () => {
    expect(BENCH_SCRIPT).toHaveLength(10);
    expect(BENCH_SCRIPT.map((t) => t.index)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(BENCH_SCRIPT.filter((t) => t.bargeIn).map((t) => t.index)).toEqual([5, 7]);
    expect(BENCH_SCRIPT.filter((t) => t.expect?.tool).map((t) => t.index)).toEqual([7, 8]);
    expect(BENCH_SCRIPT.filter((t) => t.expect?.recallOf).map((t) => t.expect!.recallOf)).toEqual([2]);
    for (const t of BENCH_SCRIPT.slice(1)) expect(t.expect).not.toBeNull();
    for (const t of BENCH_SCRIPT) {
      expect(t.text).not.toMatch(/\d{7,}/);
      expect(t.text).not.toContain("@");
    }
  });
  it("builds the worker's exact request shape and nothing else", () => {
    const body = buildBridgeRequest({
      callId: "c",
      agentId: "mokie-bench",
      goal: "g",
      context: "x",
      messages: [{ role: "user", content: "Hello?" }],
      workerBootId: "b",
      turnId: "t",
    });
    expect(body).toEqual({
      stream: true,
      messages: [{ role: "user", content: "Hello?" }],
      call: { id: "c", metadata: { hive_agent_id: "mokie-bench", goal: "g", context: "x" } },
      metadata: { voiceTrace: { schemaVersion: 2, workerBootId: "b", turnId: "t" } },
    });
    expect(Object.keys(body).sort()).toEqual(["call", "messages", "metadata", "stream"]);
  });
  it("parses the adapter's SSE framing incrementally", () => {
    const p = new SseChunkParser();
    const a = formatSSETextChunk("id", "Tok", "m");
    expect(p.push(a.slice(0, 10))).toEqual([]);
    expect(p.push(a.slice(10) + formatSSETextChunk("id", "yo", "m"))).toEqual([
      { type: "text", text: "Tok" },
      { type: "text", text: "yo" },
    ]);
    expect(p.push(formatSSEDone("id", "m", "error"))).toEqual([
      { type: "done", finishReason: "error" },
      { type: "end" },
    ]);
  });
  it("asserts keywords case-insensitively and returns null where no keywords exist", () => {
    expect(assertTurn(BENCH_SCRIPT[1]!, "There are 366 days.")).toEqual({ expectsTool: false, keywordPass: true });
    expect(assertTurn(BENCH_SCRIPT[2]!, "Kyoto.")).toEqual({ expectsTool: false, keywordPass: false });
    expect(assertTurn(BENCH_SCRIPT[6]!, "I found no results.")).toEqual({ expectsTool: true, keywordPass: true });
    expect(assertTurn(BENCH_SCRIPT[0]!, "Hi there")).toEqual({ expectsTool: false, keywordPass: null });
  });
  it("result rows never carry text", () => {
    const row = benchResultRow({
      callId: "c",
      arm: "A0-cold",
      turn: BENCH_SCRIPT[1]!,
      turnId: "t",
      assertion: { expectsTool: false, keywordPass: true },
      clientFirstTextMs: 900,
      clientTotalMs: 1400,
      textLength: 20,
      status: 200,
      finish: "stop",
    });
    expect(JSON.stringify(row)).not.toContain("366");
    expect(row).toMatchObject({ turnIndex: 2, kind: "factual", bargeIn: false, script: "kpr-465-v1" });
  });
});
