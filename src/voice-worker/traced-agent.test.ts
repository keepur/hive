import { randomUUID } from "node:crypto";
import { ReadableStream } from "node:stream/web";

import type { ChatContext, ChatMessage } from "@livekit/agents";
import { describe, expect, it, vi } from "vitest";

import type { VoiceDiagnosticEvent, VoiceTraceWriter } from "../voice/voice-trace.js";
import { SpeechTrace, type SynthesisAttempt } from "./speech-trace.js";
import { observeTtsStream, TracedAgent } from "./traced-agent.js";

type Frame = {
  sampleRate: number;
  samplesPerChannel: number;
  userdata?: Record<string, unknown>;
};

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => (resolve = done));
  return { promise, resolve };
}

function recordingAttempt() {
  const frames: Array<{ sampleRate: number; samplesPerChannel: number }> = [];
  const failures: string[] = [];
  const terminals: Array<{ outcome: string; cause: string }> = [];
  return {
    frames,
    failures,
    terminals,
    attempt: {
      frame: (frame: { sampleRate: number; samplesPerChannel: number }) => frames.push(frame),
      fail: (failure: "tts_node_failed") => failures.push(failure),
      finish: (outcome: string, cause: string) => terminals.push({ outcome, cause }),
    } as SynthesisAttempt,
  };
}

async function readAll<T>(stream: ReadableStream<T>): Promise<T[]> {
  const rows: T[] = [];
  const reader = stream.getReader();
  for (;;) {
    const next = await reader.read();
    if (next.done) return rows;
    rows.push(next.value);
  }
}

function traceHarness() {
  const rows: VoiceDiagnosticEvent[] = [];
  const complete = {
    attempted: 0,
    acknowledged: 0,
    filtered: 0,
    failed: 0,
    overflow: 0,
    pending: 0,
    unacknowledged: 0,
    sinkErrors: 0,
    complete: true,
  };
  const writer: VoiceTraceWriter = {
    write: (row) => rows.push(row),
    emit: (row) => rows.push(row),
    snapshot: () => ({ ...complete, attempted: rows.length, acknowledged: rows.length }),
    settleWrites: async () => ({ ...complete, attempted: rows.length, acknowledged: rows.length }),
  };
  const callId = "call-traced-agent";
  const workerBootId = randomUUID();
  return { rows, callId, workerBootId, trace: new SpeechTrace({ callId, workerBootId, writer }) };
}

describe("TracedAgent accepted-turn hook", () => {
  it("invokes the callback synchronously only for nonempty trimmed text", async () => {
    const accepted = vi.fn();
    const { callId, workerBootId, trace } = traceHarness();
    const agent = new TracedAgent({
      instructions: "fixture",
      callId,
      workerBootId,
      callSignal: new AbortController().signal,
      trace,
      onAcceptedUserTurn: accepted,
    });
    const message = (textContent: string | undefined) => ({ textContent }) as ChatMessage;

    const pending = agent.onUserTurnCompleted({} as ChatContext, message(" accepted "));
    expect(accepted).toHaveBeenCalledTimes(1);
    await pending;
    await agent.onUserTurnCompleted({} as ChatContext, message("  "));
    await agent.onUserTurnCompleted({} as ChatContext, message(undefined));
    expect(accepted).toHaveBeenCalledTimes(1);
    agent.dispose();
  });

  it("terminalizes a real default-node rejection under its own synthesis ID", async () => {
    const { rows, callId, workerBootId, trace } = traceHarness();
    const agent = new TracedAgent({
      instructions: "fixture",
      callId,
      workerBootId,
      callSignal: new AbortController().signal,
      trace,
      onAcceptedUserTurn: () => {},
    });
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue("no activity");
        controller.close();
      },
    });
    await expect(agent.ttsNode(source, {})).rejects.toThrow("Agent activity not found");
    expect(rows.filter((row) => row.event === "synthesis_terminal")).toEqual([
      expect.objectContaining({ outcome: "failed", errorClass: "tts_node_failed", frameCount: 0 }),
    ]);
    agent.dispose();
  });
});

describe("observeTtsStream", () => {
  it("preserves frame identity, timed metadata, and incremental delivery", async () => {
    const firstGate = gate();
    const secondGate = gate();
    const first: Frame = { sampleRate: 24_000, samplesPerChannel: 240, userdata: { timed: "alpha" } };
    const second: Frame = { sampleRate: 24_000, samplesPerChannel: 480, userdata: { timed: "beta" } };
    let pulls = 0;
    const upstream = new ReadableStream<Frame>({
      async pull(controller) {
        pulls += 1;
        if (pulls === 1) {
          await firstGate.promise;
          controller.enqueue(first);
        } else {
          await secondGate.promise;
          controller.enqueue(second);
          controller.close();
        }
      },
    });
    const observed = recordingAttempt();
    const reader = observeTtsStream(upstream, observed.attempt, new AbortController().signal).getReader();
    const firstRead = reader.read();
    firstGate.resolve();
    expect((await firstRead).value).toBe(first);
    expect(observed.frames).toEqual([{ sampleRate: 24_000, samplesPerChannel: 240 }]);
    expect(pulls).toBe(1);

    const secondRead = reader.read();
    secondGate.resolve();
    expect((await secondRead).value).toBe(second);
    expect((await reader.read()).done).toBe(true);
    expect(observed.terminals).toEqual([{ outcome: "completed", cause: "unknown" }]);
    expect(first.userdata).toEqual({ timed: "alpha" });
    expect(second.userdata).toEqual({ timed: "beta" });
  });

  it("latches cancellation before a pending read settles and never completes it", async () => {
    const entered = gate();
    const upstream = new ReadableStream<Frame>({
      pull() {
        entered.resolve();
      },
    });
    const observed = recordingAttempt();
    const reader = observeTtsStream(upstream, observed.attempt, new AbortController().signal).getReader();
    const pending = reader.read();
    await entered.promise;
    await reader.cancel();
    await pending;

    expect(observed.frames).toHaveLength(0);
    expect(observed.terminals).toEqual([{ outcome: "cancelled", cause: "framework_cancelled" }]);
    expect(upstream.locked).toBe(false);
  });

  it("does not forward a frame that races upstream cancellation", async () => {
    const entered = gate();
    const release = gate();
    const frame: Frame = { sampleRate: 16_000, samplesPerChannel: 160 };
    const upstream = new ReadableStream<Frame>({
      async pull(controller) {
        entered.resolve();
        await release.promise;
        try {
          controller.enqueue(frame);
        } catch {
          // Cancellation owns the stream before this ready frame can publish.
        }
      },
    });
    const observed = recordingAttempt();
    const reader = observeTtsStream(upstream, observed.attempt, new AbortController().signal).getReader();
    const pending = reader.read();
    await entered.promise;
    const cancelled = reader.cancel();
    release.resolve();
    await cancelled;
    await pending;
    expect(observed.frames).toHaveLength(0);
    expect(observed.terminals).toEqual([{ outcome: "cancelled", cause: "framework_cancelled" }]);
  });

  it("keeps one cancelled terminal when an upstream rejection races cancellation", async () => {
    const entered = gate();
    const release = gate();
    const upstream = new ReadableStream<Frame>({
      async pull(controller) {
        entered.resolve();
        await release.promise;
        try {
          controller.error(new Error("provider rejected"));
        } catch {
          // The cancellation path may already own the controller.
        }
      },
    });
    const observed = recordingAttempt();
    const reader = observeTtsStream(upstream, observed.attempt, new AbortController().signal).getReader();
    const pending = reader.read();
    await entered.promise;
    const cancelled = reader.cancel();
    release.resolve();
    await cancelled;
    await pending;
    expect(observed.failures).toHaveLength(0);
    expect(observed.terminals).toEqual([{ outcome: "cancelled", cause: "framework_cancelled" }]);
    expect(upstream.locked).toBe(false);
  });

  it("turns an upstream read rejection into one generic node failure", async () => {
    const observed = recordingAttempt();
    const upstream = new ReadableStream<Frame>({
      start(controller) {
        controller.error(new Error("secret provider detail"));
      },
    });
    const reader = observeTtsStream(upstream, observed.attempt, new AbortController().signal).getReader();
    await expect(reader.read()).rejects.toThrow("Voice synthesis failed");
    expect(observed.failures).toEqual(["tts_node_failed"]);
    expect(observed.terminals).toEqual([{ outcome: "failed", cause: "unknown" }]);
    expect(upstream.locked).toBe(false);
  });

  it("cancels and releases upstream when the call is aborted before first pull", async () => {
    const cancel = vi.fn();
    const upstream = new ReadableStream<Frame>({ cancel });
    const observed = recordingAttempt();
    const call = new AbortController();
    call.abort();
    const output = observeTtsStream(upstream, observed.attempt, call.signal);
    expect((await output.getReader().read()).done).toBe(true);
    await vi.waitFor(() => expect(upstream.locked).toBe(false));
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(observed.terminals).toEqual([{ outcome: "cancelled", cause: "call_closed" }]);
  });

  it("cancels a read in flight when the call is aborted", async () => {
    const entered = gate();
    const upstream = new ReadableStream<Frame>({ pull: () => entered.resolve() });
    const observed = recordingAttempt();
    const call = new AbortController();
    const reader = observeTtsStream(upstream, observed.attempt, call.signal).getReader();
    const pending = reader.read();
    await entered.promise;
    call.abort();
    expect((await pending).done).toBe(true);
    await vi.waitFor(() => expect(upstream.locked).toBe(false));
    expect(observed.terminals).toEqual([{ outcome: "cancelled", cause: "call_closed" }]);
  });

  it("retains a provider failure through normal EOF before and after a frame", async () => {
    for (const withFrame of [false, true]) {
      const { rows, callId, workerBootId, trace } = traceHarness();
      const synthesisId = `synth-${withFrame ? "after" : "before"}`;
      const attempt = trace.synthesisCreated({ callId, workerBootId, synthesisId });
      trace.synthesisFailure(synthesisId, "tts_provider_failed");
      const frame: Frame = { sampleRate: 10, samplesPerChannel: 10 };
      const input = new ReadableStream<Frame>({
        start(controller) {
          if (withFrame) controller.enqueue(frame);
          controller.close();
        },
      });
      await readAll(observeTtsStream(input, attempt, new AbortController().signal));
      expect(rows.filter((row) => row.event === "synthesis_terminal")).toEqual([
        expect.objectContaining({
          synthesisId,
          outcome: "failed",
          errorClass: "tts_provider_failed",
          frameCount: withFrame ? 1 : 0,
        }),
      ]);
    }
  });

  it("records exact final frame, sample, duration, and mixed-rate totals", async () => {
    const { rows, callId, workerBootId, trace } = traceHarness();
    const synthesisId = "synth-multirate";
    const attempt = trace.synthesisCreated({ callId, workerBootId, synthesisId });
    const frames: Frame[] = [
      { sampleRate: 10, samplesPerChannel: 10 },
      { sampleRate: 20, samplesPerChannel: 40 },
    ];
    await readAll(
      observeTtsStream(
        new ReadableStream<Frame>({
          start(controller) {
            for (const frame of frames) controller.enqueue(frame);
            controller.close();
          },
        }),
        attempt,
        new AbortController().signal,
      ),
    );
    expect(rows.find((row) => row.event === "synthesis_terminal")).toMatchObject({
      synthesisId,
      outcome: "completed",
      frameCount: 2,
      sampleCount: 50,
      sampleRate: null,
      sampleRateReason: "not_applicable",
      generatedDurationMs: { value: 3_000, reason: null },
    });
  });
});
