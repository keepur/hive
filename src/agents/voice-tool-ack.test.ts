import { describe, it, expect } from "vitest";
import {
  VOICE_TOOL_ACK_PHRASES,
  shouldInjectToolAck,
  nextAckPhrase,
} from "./voice-tool-ack.js";

describe("shouldInjectToolAck (KPR-324 §4.1 gate — spec §12.1 #1)", () => {
  const base = { enabled: true, streamedThisSegment: false, hasOnStream: true, channel: "voice" };

  it("true only when enabled + silent segment + onStream + voice", () => {
    expect(shouldInjectToolAck(base)).toBe(true);
  });

  it("false for text channels even with onStream set (load-bearing channel gate)", () => {
    for (const channel of ["slack", "sms", "ws", "internal", "scheduler", ""]) {
      expect(shouldInjectToolAck({ ...base, channel })).toBe(false);
    }
  });

  it("false when voice but onStream is missing (non-streaming degenerate)", () => {
    expect(shouldInjectToolAck({ ...base, hasOnStream: false })).toBe(false);
  });

  it("false when the segment already streamed text (natural mask wins)", () => {
    expect(shouldInjectToolAck({ ...base, streamedThisSegment: true })).toBe(false);
  });

  it("false when disabled (S7 rollback lever)", () => {
    expect(shouldInjectToolAck({ ...base, enabled: false })).toBe(false);
  });
});

describe("nextAckPhrase rotation (spec §12.1 #12)", () => {
  it("rotates in order and wraps", () => {
    let state = { index: 0 };
    const seen: string[] = [];
    for (let i = 0; i < VOICE_TOOL_ACK_PHRASES.length + 1; i++) {
      const { phrase, index } = nextAckPhrase(state);
      seen.push(phrase);
      state = { index };
    }
    expect(seen.slice(0, VOICE_TOOL_ACK_PHRASES.length)).toEqual([...VOICE_TOOL_ACK_PHRASES]);
    expect(seen[VOICE_TOOL_ACK_PHRASES.length]).toBe(VOICE_TOOL_ACK_PHRASES[0]);
  });

  it("is caller-owned: two interleaved states advance independently (no module counter)", () => {
    let a = { index: 0 };
    const b = { index: 0 };
    const r1 = nextAckPhrase(a);
    a = { index: r1.index };
    const r2 = nextAckPhrase(b); // interleaved second caller
    const r3 = nextAckPhrase(a);
    expect(r1.phrase).toBe(VOICE_TOOL_ACK_PHRASES[0]);
    expect(r2.phrase).toBe(VOICE_TOOL_ACK_PHRASES[0]); // NOT phrase[1] — no shared counter
    expect(r3.phrase).toBe(VOICE_TOOL_ACK_PHRASES[1]);
  });

  it("phrase set is phone-native: non-empty, no markdown characters", () => {
    for (const p of VOICE_TOOL_ACK_PHRASES) {
      expect(p.length).toBeGreaterThan(0);
      expect(p).not.toMatch(/[*_`#[\]]/);
    }
  });
});
