import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { voiceDiagnosticEvent, type VoiceDiagnosticEvent, type VoiceDiagnosticPayload } from "./voice-trace.js";
import {
  MAX_VOICE_DIAGNOSTIC_BYTES,
  parseVoiceDiagnosticEvent,
  parseVoiceDiagnosticJsonl,
  reduceVoiceDiagnostics,
  UnsupportedVoiceDiagnosticVersionError,
  VoiceDiagnosticInputError,
} from "./voice-diagnostic-reader.js";
import { percentile as summaryPercentile } from "../voice-worker/telemetry.js";

const COMPLETE_FIXTURE = readFileSync(
  fileURLToPath(new URL("../../docs/epics/kpr-462/fixtures/kpr-464-complete.jsonl", import.meta.url)),
  "utf8",
);
const DIAGNOSTIC_FIXTURE = readFileSync(
  fileURLToPath(new URL("../../docs/epics/kpr-462/fixtures/kpr-464-diagnostics.jsonl", import.meta.url)),
  "utf8",
);
const CLI = fileURLToPath(new URL("../../scripts/read-voice-diagnostics.ts", import.meta.url));

const workerBootId = "33333333-3333-4333-8333-333333333333";

function row(
  eventId: string,
  payload: VoiceDiagnosticPayload,
  ids: Partial<Pick<VoiceDiagnosticEvent, "speechId" | "turnId" | "synthesisId" | "engineAttemptSeq">> = {},
): VoiceDiagnosticEvent {
  return {
    ...voiceDiagnosticEvent(
      {
        component: payload.event.startsWith("engine_") ? "voice-engine" : "voice-worker",
        callId: "call-test",
        workerBootId,
        clockId: payload.event.startsWith("engine_") ? "engine-clock" : "worker-clock",
        ...ids,
      },
      payload,
    ),
    eventId,
  };
}

function jsonl(rows: VoiceDiagnosticEvent[], finalNewline = true): string {
  return rows.map((item) => JSON.stringify(item)).join("\n") + (finalNewline ? "\n" : "");
}

describe("voice diagnostic reader fixtures", () => {
  it("reduces the complete fixture with exact correlated counts and one stage-sum sample", () => {
    const report = reduceVoiceDiagnostics(COMPLETE_FIXTURE, "call-fixture");

    expect(report).toMatchObject({
      complete: true,
      speechAttempts: 2,
      bridgeAttempts: 1,
      synthesisAttempts: 2,
      engineRequests: 1,
      engineAttempts: 1,
      generatedAudioObserved: 2,
      playoutObserved: 2,
      malformedRows: 0,
      truncatedRows: 0,
      conflictingTerminals: 0,
      callerConfirmation: "unknown",
      unbound: { total: 0 },
      incomplete: { total: 0 },
    });
    expect(report.byOutcome.engineRequest).toMatchObject({ completed: 1, incomplete: 0, unknown: 0 });
    expect(report.byOutcome.engineAttempt).toMatchObject({ completed: 1, incomplete: 0, unknown: 0 });
    expect(report.distributions.estimatedEouToFirstGeneratedAudioMs).toMatchObject({
      description: expect.stringContaining("stage sum"),
      eligibleAttempts: 1,
      samples: [60],
      min: 60,
      p50: 60,
      p95: 60,
      max: 60,
      excludedByReason: { not_applicable: 1, ambiguous_components: 0 },
    });
    expect(report.distributions.estimatedEouToFirstGeneratedAudioMs.description).toContain("not measured end-to-end");
    expect(report.details.engineRequest[0]).toMatchObject({
      turnId: "turn-replacement",
      engineAttemptSeq: null,
      boundSpeechId: "speech-replacement",
      outcome: "completed",
    });
    expect(report.details.engineAttempt[0]).toMatchObject({ engineAttemptSeq: 1, outcome: "completed" });
  });

  it("retains canceled, fallback, unbound, abrupt-loss, late, duplicate, and engine retry evidence", () => {
    const report = reduceVoiceDiagnostics(DIAGNOSTIC_FIXTURE, "call-diagnostics");

    expect(report).toMatchObject({
      complete: false,
      speechAttempts: 4,
      bridgeAttempts: 2,
      synthesisAttempts: 3,
      engineRequests: 7,
      engineAttempts: 5,
      generatedAudioObserved: 2,
      playoutObserved: 1,
      gaps: { total: 2, byReason: { log_write_failed: 2 } },
      malformedRows: 0,
      conflictingTerminals: 0,
      incomplete: {
        total: 6,
        byReason: { process_loss_or_missing_terminal: 3, missing_start: 3 },
        byEntity: { speech: 1, engineRequest: 3, engineAttempt: 2 },
      },
    });
    expect(report.byOutcome.engineRequest).toMatchObject({ completed: 2, failed: 2, incomplete: 3 });
    expect(report.byOutcome.engineAttempt).toMatchObject({ completed: 2, failed: 1, incomplete: 2 });
    expect(report.distributions.estimatedEouToFirstGeneratedAudioMs).toMatchObject({
      eligibleAttempts: 0,
      excludedByReason: { not_applicable: 2, incomplete: 1, ambiguous_components: 1 },
    });
    expect(report.details.bridge.find((item) => item.turnId === "turn-replacement")).toMatchObject({
      boundSpeechId: "speech-replacement",
      terminalEventId: "d07",
      bindings: [{ eventId: "d15", speechId: "speech-replacement" }],
      lateSupplements: [expect.objectContaining({ eventId: "d15", event: "bridge_bound" })],
    });
    expect(report.details.synthesis.find((item) => item.synthesisId === "synth-two-segment")).toMatchObject({
      boundSpeechId: "speech-replacement",
      terminalEventId: "d13",
    });
  });
});

describe("voice diagnostic entity lifecycles", () => {
  it("retains unbound public playback and false-interruption observations at call level", () => {
    const playbackStarted = row("playback-started", {
      event: "output_playback",
      source: "media_output",
      metric: "playout",
      durationMs: { value: null, reason: "not_observed" },
    });
    const report = reduceVoiceDiagnostics(
      jsonl([
        playbackStarted,
        playbackStarted,
        row("playback-finished", {
          event: "output_playback",
          source: "media_output",
          metric: "playout",
          durationMs: { value: 125, reason: null },
          interrupted: false,
        }),
        row("false-interruption", { event: "false_interruption", source: "sdk_wall" }),
      ]),
      "call-test",
    );

    expect(report.callLevelObservations).toEqual({ outputPlayback: 2, falseInterruption: 1 });
    expect(report.speechAttempts).toBe(0);
    expect(report.playoutObserved).toBe(0);
  });

  it("uses the summary's shared nearest-rank contract for an even sample set", () => {
    const rows: VoiceDiagnosticEvent[] = [];
    for (const [index, eouMs] of [90, 190].entries()) {
      const speechId = `speech-percentile-${index}`;
      const turnId = `turn-percentile-${index}`;
      const synthesisId = `synth-percentile-${index}`;
      rows.push(
        row(
          `${index}-speech-start`,
          { event: "speech_started", origin: "sdk_response", acceptedEpoch: 1 },
          { speechId },
        ),
        row(
          `${index}-eou`,
          { event: "sdk_metric", source: "sdk_wall", metric: "eou", eouMs: { value: eouMs, reason: null } },
          { speechId },
        ),
        row(`${index}-bridge-start`, { event: "bridge_created" }, { turnId }),
        row(`${index}-bridge-bind`, { event: "bridge_bound", source: "sdk_metrics_context" }, { turnId, speechId }),
        row(
          `${index}-bridge-text`,
          { event: "bridge_first_text", textLength: 1, firstTextMs: { value: 5, reason: null }, late: false },
          { turnId },
        ),
        row(
          `${index}-bridge-end`,
          { event: "bridge_terminal", outcome: "completed", firstTextMs: { value: 5, reason: null } },
          { turnId },
        ),
        row(`${index}-synth-start`, { event: "synthesis_started" }, { synthesisId }),
        row(
          `${index}-synth-bind`,
          { event: "synthesis_bound", source: "sdk_metrics_context" },
          { synthesisId, speechId },
        ),
        row(
          `${index}-tts`,
          { event: "sdk_metric", source: "sdk_metrics_context", metric: "tts", ttfbMs: { value: 5, reason: null } },
          { synthesisId, speechId },
        ),
        row(
          `${index}-frame`,
          {
            event: "synthesis_first_frame",
            frameCount: 1,
            sampleCount: 1,
            sampleRate: 1,
            generatedDurationMs: { value: 1, reason: null },
          },
          { synthesisId },
        ),
        row(
          `${index}-synth-end`,
          { event: "synthesis_terminal", frameCount: 1, outcome: "completed" },
          { synthesisId },
        ),
        row(
          `${index}-speech-end`,
          {
            event: "speech_terminal",
            origin: "sdk_response",
            acceptedEpoch: 1,
            outcome: "completed",
            generatedAudio: true,
          },
          { speechId },
        ),
      );
    }
    const report = reduceVoiceDiagnostics(jsonl(rows), "call-test");
    const distribution = report.distributions.estimatedEouToFirstGeneratedAudioMs;

    expect(distribution.samples).toEqual([100, 200]);
    expect(distribution.p50).toBe(100);
    expect(summaryPercentile(distribution.samples, 50)).toBe(distribution.p50);
  });

  it("keeps request and attempt terminals separate when engine_terminal carries the final sequence", () => {
    const turnId = "engine-one";
    const rows = [
      row("received", { event: "engine_received", correlation: "worker" }, { turnId }),
      row("attempt-start", { event: "engine_attempt_started", continuity: "fresh" }, { turnId, engineAttemptSeq: 1 }),
      row("attempt-end", { event: "engine_attempt_terminal", outcome: "completed" }, { turnId, engineAttemptSeq: 1 }),
      row(
        "request-end",
        { event: "engine_terminal", outcome: "completed", generatedAudio: "unknown" },
        { turnId, engineAttemptSeq: 1 },
      ),
      row(
        "request-end",
        { event: "engine_terminal", outcome: "completed", generatedAudio: "unknown" },
        { turnId, engineAttemptSeq: 1 },
      ),
    ];
    const report = reduceVoiceDiagnostics(jsonl(rows), "call-test");

    expect(report.engineRequests).toBe(1);
    expect(report.engineAttempts).toBe(1);
    expect(report.byOutcome.engineRequest.completed).toBe(1);
    expect(report.byOutcome.engineAttempt.completed).toBe(1);
    expect(report.conflictingTerminals).toBe(0);
  });

  it("marks a different terminal unknown while the same terminal event ID is idempotent", () => {
    const speechId = "speech-conflict";
    const started = row("start", { event: "speech_started", origin: "sdk_response", acceptedEpoch: 1 }, { speechId });
    const terminal = row(
      "terminal-a",
      {
        event: "speech_terminal",
        origin: "sdk_response",
        acceptedEpoch: 1,
        outcome: "completed",
        generatedAudio: false,
      },
      { speechId },
    );
    const conflict = row(
      "terminal-b",
      { event: "speech_terminal", origin: "sdk_response", acceptedEpoch: 1, outcome: "failed", generatedAudio: false },
      { speechId },
    );
    const report = reduceVoiceDiagnostics(jsonl([started, terminal, terminal, conflict]), "call-test");

    expect(report.speechAttempts).toBe(1);
    expect(report.conflictingTerminals).toBe(1);
    expect(report.byOutcome.speech).toMatchObject({ completed: 0, failed: 0, unknown: 1 });
    expect(report.details.speech[0]).toMatchObject({ terminalEventId: "terminal-a", outcome: "unknown" });
  });

  it("accepts reordered start evidence and distinguishes both incomplete reasons", () => {
    const terminalFirst = row(
      "terminal-first",
      {
        event: "speech_terminal",
        origin: "sdk_response",
        acceptedEpoch: 1,
        outcome: "completed",
        generatedAudio: false,
      },
      { speechId: "speech-reordered" },
    );
    const lateStart = row(
      "late-start",
      { event: "speech_started", origin: "sdk_response", acceptedEpoch: 1 },
      { speechId: "speech-reordered" },
    );
    const noTerminal = row(
      "no-terminal",
      { event: "speech_started", origin: "sdk_response", acceptedEpoch: 1 },
      { speechId: "speech-loss" },
    );
    const noStart = row(
      "no-start",
      { event: "speech_terminal", origin: "sdk_response", acceptedEpoch: 1, outcome: "failed", generatedAudio: false },
      { speechId: "speech-missing-start" },
    );
    const report = reduceVoiceDiagnostics(jsonl([terminalFirst, lateStart, noTerminal, noStart]), "call-test");

    expect(report.speechAttempts).toBe(3);
    expect(report.byOutcome.speech).toMatchObject({ completed: 1, incomplete: 2, failed: 0 });
    expect(report.incomplete).toMatchObject({
      total: 2,
      byReason: { process_loss_or_missing_terminal: 1, missing_start: 1 },
    });
    expect(report.details.speech.find((item) => item.speechId === "speech-reordered")?.firstObservation.event).toBe(
      "speech_terminal",
    );
  });
});

describe("voice diagnostic input validation", () => {
  it("accepts worker teardown and summary-persistence status fields", () => {
    expect(
      parseVoiceDiagnosticEvent(row("teardown", { event: "teardown", result: "closed", reason: "call_close" })),
    ).not.toBeNull();
    expect(
      parseVoiceDiagnosticEvent(row("persistence", { event: "summary_persistence", status: "acknowledged" })),
    ).not.toBeNull();
    expect(
      parseVoiceDiagnosticEvent(
        row(
          "sse-write",
          { event: "engine_terminal", outcome: "failed", errorClass: "sse_write_failed" },
          { turnId: "turn" },
        ),
      ),
    ).not.toBeNull();
  });

  it("counts malformed rows and a malformed unterminated final row without completing an entity", () => {
    const started = row(
      "start-only",
      { event: "speech_started", origin: "sdk_response", acceptedEpoch: 1 },
      { speechId: "speech-one" },
    );
    const input = `${JSON.stringify({ legacy: true })}\nnot-json\n${JSON.stringify(started)}\n{"kind":"voice_diagnostic"`;
    const report = reduceVoiceDiagnostics(input, "call-test");

    expect(report).toMatchObject({
      complete: false,
      speechAttempts: 1,
      malformedRows: 2,
      truncatedRows: 1,
      incomplete: { total: 1 },
    });
    expect(report.byOutcome.speech.incomplete).toBe(1);
  });

  it("ignores legacy and other-call rows but rejects a selected unsupported schema", () => {
    const other = {
      ...row("other", { event: "speech_started", origin: "opening", acceptedEpoch: 0 }, { speechId: "other" }),
      callId: "other-call",
    };
    const selectedV1 = { ...other, callId: "call-test", schemaVersion: 1 };
    expect(
      reduceVoiceDiagnostics(`${JSON.stringify(other)}\n${JSON.stringify({ kind: "old_log" })}\n`, "call-test")
        .speechAttempts,
    ).toBe(0);
    expect(() => parseVoiceDiagnosticJsonl(`${JSON.stringify(selectedV1)}\n`, "call-test")).toThrow(
      UnsupportedVoiceDiagnosticVersionError,
    );
  });

  it("rejects unknown privacy-sensitive fields and never returns their values", () => {
    const unsafe = {
      ...row("unsafe", { event: "speech_started", origin: "opening", acceptedEpoch: 0 }, { speechId: "speech-unsafe" }),
      metadata: { transcript: "SECRET_SENTINEL", phone: "+15555550100", token: "TOKEN_SENTINEL" },
    };
    expect(parseVoiceDiagnosticEvent(unsafe)).toBeNull();
    const report = reduceVoiceDiagnostics(`${JSON.stringify(unsafe)}\n`, "call-test");
    expect(report.malformedRows).toBe(1);
    expect(JSON.stringify(report)).not.toMatch(/SECRET_SENTINEL|5555550100|TOKEN_SENTINEL|transcript|phone|token/);
  });

  it("rejects more than 32 MiB with the call-filtered-file instruction", () => {
    const oversized = "x".repeat(MAX_VOICE_DIAGNOSTIC_BYTES + 1);
    expect(() => parseVoiceDiagnosticJsonl(oversized, "call-test")).toThrowError(
      new VoiceDiagnosticInputError(
        "voice diagnostic input exceeds 32 MiB; supply a call-filtered file no larger than 32 MiB",
      ),
    );
  });

  it("keys identical IDs from different worker boots independently", () => {
    const speechId = randomUUID();
    const first = row("first", { event: "speech_started", origin: "opening", acceptedEpoch: 0 }, { speechId });
    const second = { ...first, eventId: "second", workerBootId: "44444444-4444-4444-8444-444444444444" };
    const report = reduceVoiceDiagnostics(jsonl([first, second]), "call-test");
    expect(report.speechAttempts).toBe(2);
    expect(new Set(report.details.speech.map((item) => item.workerBootId)).size).toBe(2);
  });
});

describe("voice diagnostic CLI", () => {
  it("returns 0 for complete file input, 1 for gaps, and supports bounded stdin", () => {
    const completePath = fileURLToPath(
      new URL("../../docs/epics/kpr-462/fixtures/kpr-464-complete.jsonl", import.meta.url),
    );
    const diagnosticsPath = fileURLToPath(
      new URL("../../docs/epics/kpr-462/fixtures/kpr-464-diagnostics.jsonl", import.meta.url),
    );
    const complete = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, "--input", completePath, "--call-id", "call-fixture"],
      {
        encoding: "utf8",
      },
    );
    const incomplete = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, "--input", diagnosticsPath, "--call-id", "call-diagnostics"],
      { encoding: "utf8" },
    );
    const stdin = spawnSync(process.execPath, ["--import", "tsx", CLI, "--input", "-", "--call-id", "call-fixture"], {
      encoding: "utf8",
      input: COMPLETE_FIXTURE,
    });

    expect(complete.status).toBe(0);
    expect(JSON.parse(complete.stdout)).toMatchObject({ complete: true, callerConfirmation: "unknown" });
    expect(incomplete.status).toBe(1);
    expect(JSON.parse(incomplete.stdout)).toMatchObject({ complete: false, gaps: { total: 2 } });
    expect(stdin.status).toBe(0);
    expect(JSON.parse(stdin.stdout)).toMatchObject({ complete: true, callId: "call-fixture" });
  });

  it("returns 2 for invalid arguments", () => {
    const result = spawnSync(process.execPath, ["--import", "tsx", CLI, "--input", "-"], {
      encoding: "utf8",
      input: "",
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("usage: read-voice-diagnostics");
  });
});
