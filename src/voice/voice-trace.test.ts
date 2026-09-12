import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createVoiceTraceWriter,
  measure,
  parseVoiceTrace,
  voiceDiagnosticEvent,
  type EnginePayload,
  type Measure,
  type TrackedVoiceLogger,
  type VoiceDiagnosticEvent,
} from "./voice-trace.js";

function event(name: "call_started" | "call_closed" = "call_started"): VoiceDiagnosticEvent {
  return voiceDiagnosticEvent(
    { component: "voice-worker", callId: "call", workerBootId: randomUUID() },
    name === "call_started"
      ? { event: name, direction: "outbound", intendedParticipant: true }
      : { event: name, reason: "call_close" },
  );
}

describe("voice trace metadata", () => {
  it("accepts only the exact bounded schema and distinguishes missing from malformed", () => {
    const workerBootId = randomUUID();
    const turnId = randomUUID();
    expect(parseVoiceTrace({ voiceTrace: { schemaVersion: 2, workerBootId, turnId } })).toEqual({
      workerBootId,
      turnId,
      correlation: "worker",
    });
    expect(parseVoiceTrace(undefined)).toMatchObject({ workerBootId: null, correlation: "legacy" });
    expect(parseVoiceTrace({ unrelated: "compatible" })).toMatchObject({ correlation: "legacy" });
    expect(parseVoiceTrace({ voiceTrace: { schemaVersion: 2, workerBootId, turnId, raw: "secret" } })).toMatchObject({
      workerBootId: null,
      correlation: "invalid",
    });
    expect(parseVoiceTrace({ voiceTrace: { schemaVersion: 2, workerBootId: "bad", turnId } })).toMatchObject({
      correlation: "invalid",
    });
  });

  it("keeps negative and nonfinite observations explicitly missing", () => {
    expect(measure(0, "not_observed")).toEqual({ value: 0, reason: null });
    expect(measure(-1, "not_observed")).toEqual({ value: null, reason: "not_observed" });
    expect(measure(Number.NaN, "correlation_missing")).toEqual({ value: null, reason: "correlation_missing" });
  });

  it("constructs the fixed content-free envelope", () => {
    const row = event();
    expect(Object.keys(row)).toEqual(
      expect.arrayContaining([
        "kind",
        "schemaVersion",
        "eventId",
        "event",
        "ts",
        "component",
        "clockId",
        "monoMs",
        "callId",
        "workerBootId",
        "speechId",
        "turnId",
        "synthesisId",
        "engineAttemptSeq",
      ]),
    );
    expect(JSON.stringify(row)).not.toMatch(/transcript|phone|audioBytes|toolArguments|metadata/);
  });

  it("keeps the KPR-465 boot and queue stage measures content-free on an engine attempt terminal", () => {
    // Typed as an intersection so the check stays honest whether or not
    // EnginePayload itself declares the two keys yet.
    const payload: EnginePayload & { bootToInitMs: Measure; queueWaitMs: Measure } = {
      event: "engine_attempt_terminal",
      outcome: "completed",
      bootToInitMs: measure(650, "not_observed"),
      queueWaitMs: measure(undefined, "not_applicable"),
    };
    const row = voiceDiagnosticEvent(
      {
        component: "voice-engine",
        callId: "call",
        workerBootId: randomUUID(),
        turnId: randomUUID(),
        engineAttemptSeq: 1,
      },
      payload,
    ) as VoiceDiagnosticEvent & { bootToInitMs: Measure; queueWaitMs: Measure };
    const serialized = JSON.stringify(row);

    expect(serialized).not.toMatch(/transcript|phone|audioBytes|toolArguments|metadata/);
    for (const forbidden of ["SENTINEL", "+1555", "Bearer "]) expect(serialized).not.toContain(forbidden);
    expect(typeof row.bootToInitMs.value).toBe("number");
    expect(row.bootToInitMs).toEqual({ value: 650, reason: null });
    expect(row.queueWaitMs.value).toBeNull();
    expect(row.queueWaitMs).toEqual({ value: null, reason: "not_applicable" });
  });
});

describe("voice trace writer", () => {
  it("counts failures and emits one nonrecursive gap after a later acknowledged row", () => {
    const rows: VoiceDiagnosticEvent[] = [];
    const results = ["failed", "acknowledged", "acknowledged"] as const;
    const logger: TrackedVoiceLogger = {
      writeTracked(_level, _message, data, callback) {
        rows.push(data as unknown as VoiceDiagnosticEvent);
        callback(results[rows.length - 1] ?? "acknowledged");
      },
      trackedSinkSnapshot: () => ({ sinkErrors: 0 }),
    };
    const writer = createVoiceTraceWriter(logger);
    writer.write(event());
    writer.write(event("call_closed"));

    expect(rows.map((row) => row.event)).toEqual(["call_started", "call_closed", "diagnostic_gap"]);
    expect(rows[2]).toMatchObject({ reason: "log_write_failed", count: 1 });
    expect(writer.snapshot()).toMatchObject({ attempted: 3, acknowledged: 2, failed: 1, complete: false });
  });

  it("does not recursively log a failed gap and retries only after a later normal ack", () => {
    const callbacks = ["failed", "acknowledged", "failed", "acknowledged", "acknowledged"] as const;
    const names: string[] = [];
    const logger: TrackedVoiceLogger = {
      writeTracked(_level, message, _data, callback) {
        names.push(message);
        callback(callbacks[names.length - 1]);
      },
      trackedSinkSnapshot: () => ({ sinkErrors: 0 }),
    };
    const writer = createVoiceTraceWriter(logger);
    writer.write(event());
    writer.write(event());
    expect(names).toEqual(["call_started", "call_started", "diagnostic_gap"]);
    writer.write(event());
    expect(names).toEqual(["call_started", "call_started", "diagnostic_gap", "call_started", "diagnostic_gap"]);
  });

  it("freezes never-acknowledged writes after a bounded timeout", async () => {
    let late: ((result: "acknowledged") => void) | undefined;
    const logger: TrackedVoiceLogger = {
      writeTracked(_level, _message, _data, callback) {
        late = callback;
      },
      trackedSinkSnapshot: () => ({ sinkErrors: 0 }),
    };
    const writer = createVoiceTraceWriter(logger);
    writer.write(event());
    const settled = await writer.settleWrites(5);
    expect(settled).toMatchObject({ pending: 0, unacknowledged: 1, acknowledged: 0, complete: false });
    late?.("acknowledged");
    expect(writer.snapshot()).toMatchObject({ unacknowledged: 1, acknowledged: 0, complete: false });
  });

  it("counts filtering as missing diagnostics without claiming delivery", () => {
    const logger: TrackedVoiceLogger = {
      writeTracked(_level, _message, _data, callback) {
        callback("filtered");
      },
      trackedSinkSnapshot: () => ({ sinkErrors: 0 }),
    };
    const writer = createVoiceTraceWriter(logger);
    writer.write(event());
    expect(writer.snapshot()).toMatchObject({
      attempted: 1,
      acknowledged: 0,
      filtered: 1,
      complete: false,
    });
  });

  it("contains logger and observer throws and includes sink error deltas", () => {
    let sinkErrors = 4;
    const logger: TrackedVoiceLogger = {
      writeTracked: vi.fn(() => {
        throw new Error("sink");
      }),
      trackedSinkSnapshot: () => ({ sinkErrors }),
    };
    const writer = createVoiceTraceWriter(logger);
    expect(() => writer.write(event())).not.toThrow();
    sinkErrors += 1;
    expect(writer.snapshot()).toMatchObject({ failed: 1, sinkErrors: 1, complete: false });
  });
});
