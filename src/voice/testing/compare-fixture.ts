/**
 * KPR-465 R1 fixture builder. Deterministic ids and clocks; content-free.
 * Mirrors the eligible-speech row shape of kpr-464-complete.jsonl (c08–c24).
 */
import type { Measure } from "../voice-trace.js";

const WB = "11111111-1111-4111-8111-111111111111";
const m = (v: number | null, reason: Measure["reason"] = null): Measure =>
  v === null ? { value: null, reason: reason ?? "not_observed" } : { value: v, reason: null };

let seq = 0;
const ts = (i: number) => new Date(Date.UTC(2026, 8, 11, 0, 0, 0, i)).toISOString();
function row(
  callId: string,
  component: "voice-worker" | "voice-engine",
  ids: Record<string, unknown>,
  payload: Record<string, unknown>,
) {
  seq += 1;
  return JSON.stringify({
    kind: "voice_diagnostic",
    schemaVersion: 2,
    eventId: `e${String(seq).padStart(5, "0")}`,
    ts: ts(seq),
    component,
    clockId: component === "voice-worker" ? "worker-clock" : "engine-clock",
    monoMs: seq,
    callId,
    workerBootId: WB,
    speechId: null,
    turnId: null,
    synthesisId: null,
    engineAttemptSeq: null,
    ...ids,
    ...payload,
  });
}

export interface FixtureTurn {
  index: number;
  /** engine stages; null ⇒ not_observed measure, "na" ⇒ not_applicable, "omit" ⇒ key absent (KPR-464-era shape) */
  boot?: number | null | "na" | "omit";
  queue?: number | null | "na" | "omit";
  lock?: number;
  init: number;
  engineFirstText: number;
  eou?: number;
  bridgeFirstText?: number;
  tts?: number;
  warm: boolean;
  selected: "fresh" | "resume" | "warm";
  continuity?: "fresh" | "resume" | "full_transcript";
  toolCount?: number;
  effort?: string | null | "omit";
  interrupted?: boolean;
  /** engine-only (bench) turn: no worker rows at all */
  engineOnly?: boolean;
  /** emit a failed first attempt before the final one (retried shape) */
  failedFirst?: boolean;
}

function stage(v: number | null | "na" | "omit" | undefined, key: string): Record<string, unknown> {
  if (v === "omit" || v === undefined) return {};
  if (v === "na") return { [key]: m(null, "not_applicable") };
  return { [key]: m(v) };
}

export function buildCall(callId: string, turns: FixtureTurn[]): string[] {
  const out: string[] = [];
  for (const t of turns) {
    const turnId = `${callId}-t${t.index}`;
    const speechId = `${callId}-s${t.index}`;
    const synthId = `${callId}-y${t.index}`;
    if (!t.engineOnly) {
      out.push(
        row(
          callId,
          "voice-worker",
          { speechId },
          { event: "speech_started", origin: "sdk_response", acceptedEpoch: t.index, source: "sdk_handle" },
        ),
      );
      out.push(row(callId, "voice-worker", { turnId }, { event: "bridge_created" }));
      out.push(
        row(callId, "voice-worker", { speechId, turnId }, { event: "bridge_bound", source: "sdk_metrics_context" }),
      );
      out.push(
        row(
          callId,
          "voice-worker",
          { speechId, turnId },
          { event: "bridge_first_text", textLength: 8, firstTextMs: m(t.bridgeFirstText ?? 20) },
        ),
      );
      out.push(
        row(
          callId,
          "voice-worker",
          { speechId, turnId },
          {
            event: "bridge_terminal",
            textLength: 8,
            firstTextMs: m(t.bridgeFirstText ?? 20),
            maximumGapMs: m(null, "not_applicable"),
            outcome: t.interrupted ? "interrupted" : "completed",
            cause: "unknown",
            errorClass: null,
          },
        ),
      );
      out.push(row(callId, "voice-worker", { synthesisId: synthId }, { event: "synthesis_started" }));
      out.push(
        row(
          callId,
          "voice-worker",
          { speechId, synthesisId: synthId },
          { event: "synthesis_bound", source: "sdk_metrics_context" },
        ),
      );
      out.push(
        row(
          callId,
          "voice-worker",
          { speechId, synthesisId: synthId },
          {
            event: "sdk_metric",
            source: "sdk_metrics_context",
            metric: "tts",
            ttfbMs: m(t.tts ?? 30),
            durationMs: m(80),
          },
        ),
      );
      out.push(
        row(
          callId,
          "voice-worker",
          { speechId },
          {
            event: "sdk_metric",
            source: "sdk_wall",
            metric: "eou",
            eouMs: m(t.eou ?? 500),
            transcriptionMs: m(4),
            onUserTurnCompletedMs: m(2),
          },
        ),
      );
      out.push(
        row(
          callId,
          "voice-worker",
          { speechId, synthesisId: synthId },
          {
            event: "synthesis_first_frame",
            frameCount: 1,
            sampleCount: 480,
            sampleRate: 24000,
            generatedDurationMs: m(20),
          },
        ),
      );
      out.push(
        row(
          callId,
          "voice-worker",
          { speechId, synthesisId: synthId },
          {
            event: "synthesis_terminal",
            frameCount: 1,
            sampleCount: 480,
            sampleRate: 24000,
            sampleRateReason: null,
            generatedDurationMs: m(20),
            outcome: t.interrupted ? "interrupted" : "completed",
            cause: "unknown",
            errorClass: null,
          },
        ),
      );
      out.push(
        row(
          callId,
          "voice-worker",
          { speechId },
          {
            event: "speech_terminal",
            origin: "sdk_response",
            acceptedEpoch: t.index,
            source: "sdk_handle",
            outcome: t.interrupted ? "interrupted" : "completed",
            cause: "unknown",
            generatedAudio: true,
            knownPlayout: true,
            sdkSettled: true,
            sdkInterrupted: t.interrupted === true,
            textLength: 8,
            startedSpeakingAt: m(12),
            generatedDurationMs: m(20),
            errorClass: null,
          },
        ),
      );
    }
    out.push(
      row(
        callId,
        "voice-engine",
        { turnId },
        { event: "engine_received", correlation: t.engineOnly ? "legacy" : "worker" },
      ),
    );
    const terminal = (
      attemptSeq: number,
      continuity: string,
      selected: string | null,
      outcome: string,
      extra: Record<string, unknown>,
    ) =>
      row(
        callId,
        "voice-engine",
        { turnId, engineAttemptSeq: attemptSeq },
        {
          event: "engine_attempt_terminal",
          continuity,
          launchAdmission: selected === "warm" ? null : selected,
          selectedContinuity: selected,
          warm: t.warm,
          outcome,
          errorClass: outcome === "failed" ? "spawn_failed" : null,
          durationMs: m(t.engineFirstText + 100),
          firstTextMs: outcome === "failed" ? m(null, "not_reached") : m(t.engineFirstText),
          stopped: false,
          ...extra,
        },
      );
    const stages = {
      lockWaitMs: t.warm ? m(0) : m(t.lock ?? 0),
      spawnPrepMs: m(2),
      initToFirstTokenMs: m(t.init),
      ...stage(t.boot, "bootToInitMs"),
      ...stage(t.queue, "queueWaitMs"),
      // `effort` is emitted only when the turn sets it explicitly. The cold/warm
      // defaults below carry the delivered effort (`null` / `"medium"`, KPR-465
      // chunk C); `"omit"` keeps the key absent (KPR-464-era shape, `call-old`).
      ...(t.effort !== undefined && t.effort !== "omit" ? { effort: t.effort } : {}),
      ...(t.toolCount !== undefined
        ? { toolCount: t.toolCount, toolMs: t.toolCount * 400, toolAckInjected: t.toolCount > 0 }
        : {}),
    };
    let attemptSeq = 1;
    if (t.failedFirst) {
      out.push(
        row(
          callId,
          "voice-engine",
          { turnId, engineAttemptSeq: 1 },
          { event: "engine_attempt_started", continuity: t.warm ? "resume" : "resume" },
        ),
      );
      out.push(
        terminal(1, "resume", "resume", "failed", {
          bootToInitMs: m(null, "not_observed"),
          queueWaitMs: m(null, "not_observed"),
          lockWaitMs: m(0),
          spawnPrepMs: m(1),
          initToFirstTokenMs: m(null, "not_reached"),
        }),
      );
      attemptSeq = 2;
    }
    const continuity = t.continuity ?? (t.selected === "warm" ? "resume" : t.selected);
    out.push(
      row(
        callId,
        "voice-engine",
        { turnId, engineAttemptSeq: attemptSeq },
        { event: "engine_attempt_started", continuity },
      ),
    );
    out.push(terminal(attemptSeq, continuity, t.selected, t.interrupted ? "cancelled" : "completed", stages));
    out.push(
      row(
        callId,
        "voice-engine",
        { turnId, engineAttemptSeq: attemptSeq },
        {
          event: "engine_terminal",
          status: 200,
          outcome: t.interrupted ? "cancelled" : "completed",
          errorClass: null,
          durationMs: m(t.engineFirstText + 120),
          firstTextMs: m(t.engineFirstText),
          correlation: t.engineOnly ? "legacy" : "worker",
          generatedAudio: "unknown",
          warm: t.warm,
        },
      ),
    );
  }
  return out;
}

export function buildCompareFixture(): { jsonl: string; engineLog: string; benchResults: string } {
  seq = 0;
  const cold = (index: number, extra: Partial<FixtureTurn> = {}): FixtureTurn => ({
    index,
    warm: false,
    selected: index === 1 ? "fresh" : "resume",
    boot: 640 + index,
    queue: "na",
    lock: index === 3 ? 831 : 0,
    init: 1200 + 50 * index,
    engineFirstText: 1900 + 50 * index,
    eou: 520 + index,
    tts: 230 + index,
    effort: null,
    ...extra,
  });
  const warm = (index: number, extra: Partial<FixtureTurn> = {}): FixtureTurn => ({
    index,
    warm: true,
    selected: index === 1 ? "fresh" : "warm",
    boot: index === 1 ? 655 : "na",
    queue: 40 + index,
    init: 1150 + 40 * index,
    engineFirstText: 1250 + 40 * index,
    eou: 515 + index,
    tts: 225 + index,
    effort: "medium",
    ...extra,
  });
  const lines = [
    ...buildCall("call-cold-a", [
      cold(1),
      cold(2),
      cold(3),
      cold(4, { toolCount: 1 }),
      cold(5, { interrupted: true }),
      cold(6),
    ]),
    ...buildCall("call-warm-a", [
      warm(1),
      warm(2),
      warm(3),
      warm(4, { toolCount: 1 }),
      warm(5, { failedFirst: true, continuity: "full_transcript", selected: "fresh", boot: 660 }),
      warm(6),
    ]),
    ...buildCall("call-warm-mislabel", [
      warm(1),
      warm(2),
      { ...warm(3), warm: false, selected: "resume", boot: 650, queue: "na" },
    ]),
    ...buildCall("call-cold-mislabel", [
      cold(1),
      cold(2),
      { ...cold(3), warm: true, selected: "warm", boot: "na", queue: 12 },
    ]),
    ...buildCall("call-bench-1", [
      warm(1, { engineOnly: true }),
      warm(2, { engineOnly: true }),
      warm(3, { engineOnly: true }),
      warm(4, { engineOnly: true, toolCount: 1 }),
    ]),
    ...buildCall("call-old", [
      cold(1, { boot: "omit", queue: "omit", effort: "omit" }),
      cold(2, { boot: "omit", queue: "omit", effort: "omit" }),
    ]),
  ];
  const engineLog = [
    ...[1, 2, 3, 4, 6].map((i) =>
      JSON.stringify({
        ts: ts(i),
        level: "info",
        component: "voice-adapter",
        msg: "Voice turn complete",
        callId: "call-cold-a",
        turnId: `call-cold-a-t${i}`,
        bootToInitMs: 640 + i,
        initToFirstTokenMs: 1200 + 50 * i,
        warmPath: false,
      }),
    ),
    JSON.stringify({
      ts: ts(9),
      level: "info",
      component: "voice-adapter",
      msg: "Voice turn complete",
      callId: "call-warm-a",
      turnId: "call-warm-a-t1",
      bootToInitMs: 655,
      initToFirstTokenMs: 1190,
      warmPath: true,
      warmTurnSeq: 1,
    }),
    JSON.stringify({
      ts: ts(10),
      level: "info",
      component: "voice-adapter",
      msg: "Voice turn complete",
      callId: "call-warm-a",
      turnId: "call-warm-a-t2",
      initToFirstTokenMs: 1231,
      warmPath: true,
      warmTurnSeq: 2,
    }), // DISAGREES: jsonl says 1230
    JSON.stringify({ ts: ts(11), level: "info", component: "other", msg: "unrelated row", callId: "call-warm-a" }),
  ];
  const benchResults = [1, 2, 3, 4].map((i) =>
    JSON.stringify({
      callId: "call-bench-1",
      arm: "A1-warm-bench",
      turnIndex: i,
      turnId: `call-bench-1-t${i}`,
      expectsTool: i === 4,
      keywordPass: i === 4 ? null : true,
      clientFirstTextMs: 1300 + i,
      textLength: 8,
      status: 200,
    }),
  );
  return {
    jsonl: `${lines.join("\n")}\n`,
    engineLog: `${engineLog.join("\n")}\n`,
    benchResults: `${benchResults.join("\n")}\n`,
  };
}
