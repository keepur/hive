import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { Agent, AgentSession, AgentSessionEventTypes, initializeLogger } from "@livekit/agents";
import { afterAll, describe, expect, it } from "vitest";

import { formatSSEDone, formatSSETextChunk } from "../channels/voice/openai-translator.js";
import {
  VOICE_PROCESS_ID,
  type VoiceDiagnosticEvent,
  type VoiceTraceWriteCounts,
  type VoiceTraceWriter,
} from "../voice/voice-trace.js";
import { BridgeError, HiveLLM } from "./hive-llm.js";
import { SpeechTrace } from "./speech-trace.js";
import { StartupActionOwnership, StartupArbiter, type CreationToken, type RecoveryChain } from "./startup-arbiter.js";
import {
  CaptureAudioOutput,
  ControlledLLM,
  ControlledTTS,
  namedBarrier,
  until,
  type LlmPlan,
  type SpeechHandle,
  type TtsPlan,
} from "./testing/startup-fixture.js";
import { TracedAgent } from "./traced-agent.js";

initializeLogger({ pretty: false, level: "silent" });

const sessions = new Set<AgentSession>();
const COMPLETE_WRITES: VoiceTraceWriteCounts = {
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

function traceHarness(callId: string, writerOverrides: Partial<VoiceTraceWriter> = {}) {
  const rows: VoiceDiagnosticEvent[] = [];
  const writer: VoiceTraceWriter = {
    write: (event) => rows.push(event),
    emit: (event) => rows.push(event),
    snapshot: () => ({ ...COMPLETE_WRITES, attempted: rows.length, acknowledged: rows.length }),
    settleWrites: async () => ({ ...COMPLETE_WRITES, attempted: rows.length, acknowledged: rows.length }),
    ...writerOverrides,
  };
  return { rows, trace: new SpeechTrace({ callId, workerBootId: VOICE_PROCESS_ID, writer }) };
}

type Pipeline = Awaited<ReturnType<typeof pipeline>>;

async function pipeline(
  id: string,
  options: {
    llmPlans?: LlmPlan[];
    ttsPlans?: TtsPlan[];
    recover?: (
      chain: RecoveryChain<BridgeError>,
      error: BridgeError,
      actions: StartupActionOwnership<BridgeError>,
      fixture: Pipeline,
    ) => Promise<void>;
  } = {},
) {
  const llm = new ControlledLLM();
  llm.plans.push(...(options.llmPlans ?? []));
  const tts = new ControlledTTS();
  tts.plans.push(...(options.ttsPlans ?? []));
  const output = new CaptureAudioOutput();
  const callAbort = new AbortController();
  const { rows, trace } = traceHarness(`startup-${id}`);
  const session = new AgentSession({ llm, tts, vad: null, turnHandling: { turnDetection: null } });
  session.output.audio = output;
  const created: SpeechHandle[] = [];
  const tokens: CreationToken[] = [];
  // Assigned after the arbiter because its opening callback closes over the owner.
  // eslint-disable-next-line prefer-const
  let ownership!: StartupActionOwnership<BridgeError>;
  const arbiter = new StartupArbiter({
    requestOpening: () => ownership.scheduleOwned("opening", () => session.generateReply()),
    observe: (event) => {
      if (event.kind === "decision") {
        trace.call({ event: "opening_decision", decision: event.decision, reason: event.reason });
      } else if (event.kind === "cancel") {
        trace.markCancellation(event.speechId, event.reason);
      }
    },
  });
  const fixture = {
    id,
    llm,
    tts,
    output,
    callAbort,
    rows,
    trace,
    session,
    created,
    tokens,
    arbiter,
    ownership: undefined as unknown as StartupActionOwnership<BridgeError>,
    agent: undefined as unknown as TracedAgent,
    async accept(text: string) {
      await fixture.agent.onUserTurnCompleted({} as never, { textContent: text } as never);
    },
    async close() {
      arbiter.close();
      ownership.close();
      callAbort.abort();
      fixture.agent.dispose();
      trace.close("call_closed");
      sessions.delete(session);
      await session.close().catch(() => {});
    },
  };
  ownership = new StartupActionOwnership<BridgeError>({
    arbiter,
    trace,
    recover: (chain, error, actions) => options.recover?.(chain, error, actions, fixture),
  });
  fixture.ownership = ownership;
  const agent = new TracedAgent({
    instructions: "offline startup integration fixture",
    tts,
    callId: `startup-${id}`,
    workerBootId: VOICE_PROCESS_ID,
    callSignal: callAbort.signal,
    trace,
    onAcceptedUserTurn: () => ownership.acceptCallerTurn(),
  });
  fixture.agent = agent;
  session.on(AgentSessionEventTypes.SpeechCreated, ({ speechHandle }) => {
    const scope = ownership.generationScope;
    trace.speechCreated(speechHandle, scope?.origin ?? "sdk_response", scope?.epoch ?? arbiter.epoch);
    const token = ownership.registerSpeech(speechHandle);
    if (token) tokens.push(token);
    created.push(speechHandle);
  });
  session.on(AgentSessionEventTypes.MetricsCollected, (event) => {
    trace.metrics(event);
    if (event.metrics.type === "eou_metrics" && event.metrics.speechId) ownership.admitEou(event.metrics.speechId);
  });
  sessions.add(session);
  await session.start({ agent });
  return fixture;
}

afterAll(async () => {
  await Promise.all([...sessions].map((session) => session.close().catch(() => {})));
});

function outputText(fixture: Pick<Pipeline, "output">): string {
  return fixture.output.transcriptTexts().join("");
}

async function waitForOutput(fixture: Pick<Pipeline, "output">, expected: string): Promise<void> {
  await until(() => outputText(fixture).includes(expected), `fake output ${expected}`);
}

async function startBridgeServer(
  respond: (
    index: number,
    body: Record<string, unknown>,
  ) => { status?: number; chunks?: string[]; close?: boolean; closeAfterChunks?: boolean },
) {
  const requests: Record<string, unknown>[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
      requests.push(body);
      const reply = respond(requests.length - 1, body);
      res.writeHead(reply.status ?? 200, { "Content-Type": "text/event-stream" });
      if (reply.close) {
        res.destroy();
        return;
      }
      for (const text of reply.chunks ?? []) {
        res.write(formatSSETextChunk(`startup-${requests.length}`, text, "hive"));
      }
      if (reply.closeAfterChunks) {
        setImmediate(() => res.destroy());
        return;
      }
      res.end(formatSSEDone(`startup-${requests.length}`, "hive"));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    server,
    requests,
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

async function httpSession(id: string, server: Awaited<ReturnType<typeof startBridgeServer>>) {
  const { rows, trace } = traceHarness(`http-${id}`);
  const callAbort = new AbortController();
  const llm = new HiveLLM({
    bridgeUrl: server.url,
    bridgeToken: "offline-token",
    hiveAgentId: "offline-agent",
    callId: `http-${id}`,
    goal: "offline startup proof",
    context: "test only",
    trace,
    callSignal: callAbort.signal,
  });
  const lifecycle: string[] = [];
  llm.on("error", () => lifecycle.push("application_error"));
  const tts = new ControlledTTS();
  const output = new CaptureAudioOutput();
  const session = new AgentSession({ llm, tts, vad: null, turnHandling: { turnDetection: null } });
  session.output.audio = output;
  session.on(AgentSessionEventTypes.MetricsCollected, (event) => trace.metrics(event));
  sessions.add(session);
  await session.start({ agent: new Agent({ instructions: "offline startup proof", tts }) });
  return {
    rows,
    trace,
    callAbort,
    llm,
    lifecycle,
    tts,
    output,
    session,
    async close() {
      callAbort.abort();
      trace.close("call_closed");
      sessions.delete(session);
      await session.close().catch(() => {});
    },
  };
}

describe("S1-S3 startup progression with the real SDK", () => {
  it("S1 quiet answer requests exactly one opening and reaches fake output", async () => {
    const fixture = await pipeline("s1-quiet", {
      llmPlans: [{ turnId: "s1-opening", text: "S1_OPENING" }],
    });
    try {
      fixture.arbiter.answer();
      await waitForOutput(fixture, "S1_OPENING");
      await fixture.created[0]!.waitForPlayout();

      expect(fixture.created).toHaveLength(1);
      expect(fixture.llm.streams).toHaveLength(1);
      expect(fixture.tts.streams).toHaveLength(1);
      expect(outputText(fixture)).toContain("S1_OPENING");
      expect(fixture.rows.filter((row) => row.event === "opening_decision")).toEqual([
        expect.objectContaining({ decision: "request", reason: "quiet_answer" }),
      ]);
    } finally {
      await fixture.close();
    }
  });

  it("reproduces the old unconditional post-answer duplicate with controlled HTTP", async () => {
    const server = await startBridgeServer((index) => ({
      chunks: [index === 0 ? "BASELINE_EARLY" : "BASELINE_OPENING"],
    }));
    const fixture = await httpSession("baseline", server);
    const sequence: string[] = [];
    try {
      sequence.push("early_greeting_accepted_while_answer_pending");
      const early = fixture.session.generateReply({ userInput: "early hello" });
      sequence.push(`speech_created:${early.id}`);
      await early.waitForPlayout();
      sequence.push("sip_answer_resolved");
      // Test-only baseline: this is the pre-fix unconditional post-answer call.
      const unconditional = fixture.session.generateReply();
      sequence.push(`speech_created:${unconditional.id}`);
      await unconditional.waitForPlayout();

      expect(server.requests).toHaveLength(2);
      expect(sequence).toEqual([
        "early_greeting_accepted_while_answer_pending",
        expect.stringMatching(/^speech_created:speech_/),
        "sip_answer_resolved",
        expect.stringMatching(/^speech_created:speech_/),
      ]);
      expect(fixture.output.transcriptTexts().join("")).toContain("BASELINE_EARLY");
      expect(fixture.output.transcriptTexts().join("")).toContain("BASELINE_OPENING");
      expect([early.interrupted, unconditional.interrupted]).toEqual([false, false]);
    } finally {
      await fixture.close();
      await server.close();
    }
  });

  it.each(["before-answer", "during-answer", "accepted-before-decision"] as const)(
    "S2 %s retains final-pending ownership and preserves the caller transcript",
    async (order) => {
      const fixture = await pipeline(`s2-${order}`, {
        llmPlans: [{ turnId: `s2-${order}-caller`, text: "S2_CALLER_REPLY" }],
      });
      try {
        if (order !== "accepted-before-decision") fixture.arbiter.finalInput(true);
        if (order === "during-answer") fixture.arbiter.callerState("speaking");
        if (order === "accepted-before-decision") await fixture.accept("early hello sentinel");
        fixture.arbiter.answer();
        fixture.arbiter.callerState("listening");
        if (order !== "accepted-before-decision") await fixture.accept("early hello sentinel");
        const caller = fixture.session.generateReply({ userInput: "early hello sentinel" });
        await waitForOutput(fixture, "S2_CALLER_REPLY");
        await caller.waitForPlayout();

        expect(fixture.created).toHaveLength(1);
        expect(fixture.rows).not.toContainEqual(
          expect.objectContaining({ event: "opening_decision", decision: "request" }),
        );
        expect(fixture.llm.requests).toHaveLength(1);
        expect(fixture.llm.requests[0]).toContainEqual({ role: "user", text: "early hello sentinel" });
        expect(outputText(fixture)).toContain("S2_CALLER_REPLY");
      } finally {
        await fixture.close();
      }
    },
  );

  it.each(["before-text", "before-frame", "during-playout"] as const)(
    "S3 immediate input at %s cancels only the opening and progresses replacement",
    async (stage) => {
      const oldGate = namedBarrier(`s3-${stage}-old`);
      const oldTts: TtsPlan = {
        mode: stage === "during-playout" ? "hold-after-frame" : "hold-before-frame",
        entered: namedBarrier(`s3-${stage}-tts-entered`),
        release: oldGate,
      };
      const fixture = await pipeline(`s3-${stage}`, {
        llmPlans: [
          {
            turnId: `s3-${stage}-opening`,
            text: "STALE_OPENING",
            holdBeforeText: stage === "before-text" ? oldGate : undefined,
          },
          { turnId: `s3-${stage}-replacement`, text: "S3_REPLACEMENT" },
        ],
        ttsPlans: stage === "before-text" ? [] : [oldTts, { mode: "normal" }],
      });
      try {
        fixture.arbiter.answer();
        await fixture.llm.streams[0]!.entered.promise;
        if (stage !== "before-text") await oldTts.entered!.promise;
        if (stage === "during-playout") await waitForOutput(fixture, "STALE_OPENING");
        const staleFramesAtAcceptance = fixture.output.frames.length;

        fixture.arbiter.finalInput(true);
        await fixture.accept("replace now");
        const replacement = fixture.session.generateReply({ userInput: "replace now" });
        await waitForOutput(fixture, "S3_REPLACEMENT");
        oldGate.resolve();
        await Promise.all(fixture.created.map((handle) => handle.waitForPlayout()));

        expect(fixture.created).toHaveLength(2);
        expect(fixture.created[0]!.interrupted).toBe(true);
        expect(replacement.interrupted).toBe(false);
        expect(fixture.llm.streams).toHaveLength(2);
        expect(outputText(fixture)).toContain("S3_REPLACEMENT");
        expect(fixture.output.transcriptTexts().filter((text) => text.includes("STALE_OPENING"))).toHaveLength(
          stage === "during-playout" ? 1 : 0,
        );
        expect(fixture.output.frames.length).toBe(staleFramesAtAcceptance + 1);
      } finally {
        oldGate.resolve();
        await fixture.close();
      }
    },
  );
});

type S4Case = {
  id: string;
  kind: "final-hold" | "quiet-release" | "delayed-final";
};

const S4_CASES: S4Case[] = [
  { id: "S4-01-stt-preemptive-final-before-answer", kind: "final-hold" },
  { id: "S4-02-vad-preemptive-final-before-answer", kind: "final-hold" },
  { id: "S4-03-vad-nonpreemptive-final-before-answer", kind: "final-hold" },
  { id: "S4-04-stt-preflight-final-before-answer", kind: "final-hold" },
  { id: "S4-05-stt-answer-at-final", kind: "final-hold" },
  { id: "S4-06-stt-answer-at-listening", kind: "final-hold" },
  { id: "S4-07-stt-answer-at-accepted", kind: "final-hold" },
  { id: "S4-08-vad-answer-at-final", kind: "final-hold" },
  { id: "S4-09-vad-answer-at-listening", kind: "final-hold" },
  { id: "S4-10-vad-answer-at-accepted", kind: "final-hold" },
  { id: "S4-11-stt-absent", kind: "quiet-release" },
  { id: "S4-12-stt-interim", kind: "quiet-release" },
  { id: "S4-13-stt-empty-final", kind: "quiet-release" },
  { id: "S4-14-stt-preflight-only", kind: "quiet-release" },
  { id: "S4-15-vad-absent", kind: "quiet-release" },
  { id: "S4-16-vad-interim", kind: "quiet-release" },
  { id: "S4-17-vad-empty-final", kind: "quiet-release" },
  { id: "S4-18-vad-preflight-only", kind: "quiet-release" },
  { id: "S4-19-stt-absent-delayed-final", kind: "delayed-final" },
  { id: "S4-20-stt-interim-delayed-final", kind: "delayed-final" },
  { id: "S4-21-vad-absent-delayed-final", kind: "delayed-final" },
  { id: "S4-22-vad-interim-delayed-final", kind: "delayed-final" },
];

describe("S4 complete production-arbiter matrix", () => {
  it.each(S4_CASES)("$id progresses with exact application attempts", async ({ id, kind }) => {
    const openingGate = namedBarrier(`${id}-opening-text`);
    const fixture = await pipeline(id, {
      llmPlans:
        kind === "delayed-final"
          ? [
              { turnId: `${id}-opening`, text: "S4_STALE_OPENING", holdBeforeText: openingGate },
              { turnId: `${id}-caller`, text: "S4_CALLER_REPLY" },
            ]
          : [
              {
                turnId: `${id}-${kind === "quiet-release" ? "opening" : "caller"}`,
                text: kind === "quiet-release" ? "S4_OPENING" : "S4_CALLER_REPLY",
              },
            ],
    });
    try {
      if (kind === "final-hold") {
        fixture.arbiter.callerState("speaking");
        fixture.arbiter.finalInput(true);
        fixture.arbiter.answer();
        fixture.arbiter.callerState("listening");
        await fixture.accept("S4 accepted final");
        const caller = fixture.session.generateReply({ userInput: "S4 accepted final" });
        await caller.waitForPlayout();
        expect(outputText(fixture)).toContain("S4_CALLER_REPLY");
        expect(fixture.rows).not.toContainEqual(
          expect.objectContaining({ event: "opening_decision", decision: "request" }),
        );
      } else {
        fixture.arbiter.callerState("speaking");
        fixture.arbiter.answer();
        fixture.arbiter.callerState("listening");
        if (kind === "quiet-release") {
          await fixture.created[0]!.waitForPlayout();
          expect(outputText(fixture)).toContain("S4_OPENING");
        } else {
          await fixture.llm.streams[0]!.entered.promise;
          fixture.arbiter.finalInput(true);
          await fixture.accept("S4 delayed final");
          const caller = fixture.session.generateReply({ userInput: "S4 delayed final" });
          await caller.waitForPlayout();
          openingGate.resolve();
          await fixture.created[0]!.waitForPlayout();
          expect(fixture.created[0]!.interrupted).toBe(true);
          expect(outputText(fixture)).not.toContain("S4_STALE_OPENING");
          expect(outputText(fixture)).toContain("S4_CALLER_REPLY");
        }
      }

      expect(fixture.created).toHaveLength(kind === "delayed-final" ? 2 : 1);
      expect(fixture.llm.streams).toHaveLength(kind === "delayed-final" ? 2 : 1);
    } finally {
      openingGate.resolve();
      await fixture.close();
    }
  });

  it("admits the exact preemptive EOU identity without mutating creation order", async () => {
    const holdA = namedBarrier("s4-eou-a-text");
    const holdOpening = namedBarrier("s4-eou-opening-text");
    const fixture = await pipeline("s4-exact-eou", {
      llmPlans: [
        { turnId: "s4-preemptive-a", text: "PREEMPTIVE_A", holdBeforeText: holdA },
        { turnId: "s4-newer-opening", text: "NEWER_OPENING", holdBeforeText: holdOpening },
      ],
    });
    try {
      const preemptive = fixture.session.generateReply({ userInput: "preemptive A" });
      await fixture.llm.streams[0]!.entered.promise;
      const tokenA = fixture.tokens[0]!;
      await fixture.accept("accepted A");
      const application = fixture.ownership.scheduleOwned("opening", () => fixture.session.generateReply());
      await fixture.llm.streams[1]!.entered.promise;
      const tokenOpening = fixture.tokens[1]!;
      fixture.ownership.admitEou(preemptive.id);

      expect(fixture.ownership.currentOwner).toMatchObject({
        source: "eou",
        creation: tokenA,
        acceptedEpoch: 1,
      });
      expect(tokenA).toMatchObject({ speechId: preemptive.id, createdEpoch: 0, serial: 1 });
      expect(tokenOpening).toMatchObject({ speechId: application.id, createdEpoch: 1, serial: 2 });
      fixture.ownership.admitEou(preemptive.id);
      expect(fixture.ownership.currentOwner?.creation).toBe(tokenA);
    } finally {
      holdA.resolve();
      holdOpening.resolve();
      await fixture.close();
    }
  });

  it("keeps EOU(A) admitted before hook B and ignores duplicate or late A", async () => {
    const holdA = namedBarrier("s4-two-turn-a");
    const holdB = namedBarrier("s4-two-turn-b");
    const fixture = await pipeline("s4-two-turn-eou", {
      llmPlans: [
        { turnId: "s4-two-turn-a", text: "TURN_A", holdBeforeText: holdA },
        { turnId: "s4-two-turn-b", text: "TURN_B", holdBeforeText: holdB },
      ],
    });
    try {
      const speechA = fixture.session.generateReply({ userInput: "turn A" });
      await fixture.llm.streams[0]!.entered.promise;
      await fixture.accept("turn A");
      fixture.ownership.admitEou(speechA.id);
      expect(fixture.ownership.currentOwner?.creation.speechId).toBe(speechA.id);

      const speechB = fixture.session.generateReply({ userInput: "turn B" });
      await fixture.llm.streams[1]!.entered.promise;
      await fixture.accept("turn B");
      fixture.ownership.admitEou(speechB.id);
      const ownerB = fixture.ownership.currentOwner;
      fixture.ownership.admitEou(speechA.id);
      fixture.ownership.admitEou(speechA.id);
      expect(fixture.ownership.currentOwner).toBe(ownerB);
      expect(ownerB?.creation.speechId).toBe(speechB.id);
    } finally {
      holdA.resolve();
      holdB.resolve();
      await fixture.close();
    }
  });
});

describe("S5-S7 terminal and diagnostic paths", () => {
  it.each(["fetch", "tts-before-frame", "tts-after-frame", "replacement"] as const)(
    "S5 hangup during %s leaves no late frame or recovery",
    async (stage) => {
      const barrier = namedBarrier(`s5-${stage}`);
      const ttsPlan: TtsPlan = {
        mode: stage === "tts-after-frame" ? "hold-after-frame" : "hold-before-frame",
        entered: namedBarrier(`s5-${stage}-tts-entered`),
        release: barrier,
      };
      const fixture = await pipeline(`s5-${stage}`, {
        llmPlans: [
          {
            turnId: `s5-${stage}-first`,
            text: "S5_OLD",
            holdBeforeText: stage === "fetch" ? barrier : undefined,
          },
          ...(stage === "replacement"
            ? [{ turnId: "s5-replacement", text: "S5_REPLACEMENT", holdBeforeText: barrier }]
            : []),
        ],
        ttsPlans: stage === "fetch" || stage === "replacement" ? [] : [ttsPlan],
      });
      try {
        fixture.arbiter.answer();
        await fixture.llm.streams[0]!.entered.promise;
        if (stage.startsWith("tts")) await ttsPlan.entered!.promise;
        if (stage === "tts-after-frame") await waitForOutput(fixture, "S5_OLD");
        if (stage === "replacement") {
          await fixture.accept("replacement before hangup");
          fixture.session.generateReply({ userInput: "replacement before hangup" });
          await fixture.llm.streams[1]!.entered.promise;
        }
        const beforeClose = fixture.output.frames.length;
        await fixture.close();
        barrier.resolve();
        await Promise.all(fixture.created.map((handle) => handle.waitForPlayout().catch(() => {})));

        expect(fixture.output.frames).toHaveLength(beforeClose);
        expect(fixture.created).toHaveLength(stage === "replacement" ? 2 : 1);
        expect(fixture.llm.streams).toHaveLength(stage === "replacement" ? 2 : 1);
        expect(fixture.ownership.activeRecoveryCount).toBe(0);
        expect(fixture.ownership.applicationHandleCount).toBe(0);
        expect(fixture.trace.snapshot().registry).toEqual({
          activeSpeech: 0,
          recentSpeech: 0,
          activeBridge: 0,
          recentBridge: 0,
          activeSynthesis: 0,
          recentSynthesis: 0,
        });
      } finally {
        barrier.resolve();
        await fixture.close();
      }
    },
  );

  it("S6 empty HTTP success is explicit no-content and creates no synthesis or output", async () => {
    const server = await startBridgeServer(() => ({ chunks: [] }));
    const fixture = await httpSession("s6-empty", server);
    try {
      const empty = fixture.session.generateReply({ userInput: "empty response" });
      await empty.waitForPlayout();
      await until(
        () => fixture.rows.some((row) => row.event === "bridge_terminal" && row.outcome === "completed"),
        "empty bridge terminal",
      );

      expect(server.requests).toHaveLength(1);
      expect(fixture.output.frames).toHaveLength(0);
      expect(fixture.tts.streams).toHaveLength(0);
      expect(fixture.rows).toContainEqual(
        expect.objectContaining({ event: "bridge_terminal", outcome: "completed", textLength: 0 }),
      );
      expect(fixture.trace.snapshot()).toMatchObject({ bridgeAttempts: 1, generatedAudioObserved: 0 });
    } finally {
      await fixture.close();
      await server.close();
    }
  });

  it.each(["http-rejection", "midstream-body-error"] as const)(
    "S6 %s records application failure before terminal settlement",
    async (failure) => {
      const server = await startBridgeServer(() =>
        failure === "http-rejection"
          ? { status: 503, chunks: [] }
          : { chunks: ["S6_PARTIAL."], closeAfterChunks: true },
      );
      const fixture = await httpSession(`s6-${failure}`, server);
      try {
        const handle = fixture.session.generateReply({ userInput: `trigger ${failure}` });
        handle.addDoneCallback(() => fixture.lifecycle.push("handle_terminal"));
        await handle.waitForPlayout();
        await until(
          () => fixture.rows.some((row) => row.event === "bridge_terminal" && row.outcome === "failed"),
          `${failure} bridge terminal`,
        );
        const terminal = fixture.rows.findIndex((row) => row.event === "bridge_terminal" && row.outcome === "failed");

        expect(server.requests).toHaveLength(1);
        expect(terminal).toBeGreaterThanOrEqual(0);
        expect(fixture.lifecycle).toEqual(["application_error", "handle_terminal"]);
        expect(handle.exception() ?? null).toBeNull();
        expect(fixture.trace.snapshot().bridgeOutcomes.failed).toBe(1);
        if (failure === "http-rejection") {
          expect(fixture.output.frames).toHaveLength(0);
        } else {
          expect(fixture.rows).toContainEqual(expect.objectContaining({ event: "bridge_first_text" }));
        }
      } finally {
        await fixture.close();
        await server.close();
      }
    },
  );

  it.each(["error-before-hook", "accepted-before-binding"] as const)(
    "S6 %s waits for exact EOU and binding, then recovers without another utterance",
    async (order) => {
      let recoveries = 0;
      let fallback!: SpeechHandle;
      const fixture = await pipeline(`s6-${order}`, {
        llmPlans: [{ turnId: `s6-${order}-speech`, fail: true }],
        recover: async (chain, _error, actions, current) => {
          recoveries += 1;
          fallback = actions.scheduleOwned("fallback", () => current.session.say("S6_RECOVERY"), chain);
          await actions.waitOwned(chain, () => fallback.waitForPlayout());
        },
      });
      try {
        const speculative = fixture.session.generateReply({ userInput: "accepted failure" });
        await fixture.llm.streams[0]!.entered.promise;
        await speculative.waitForPlayout();
        const turnId = randomUUID();
        const attempt = fixture.trace.bridgeCreated({
          workerBootId: VOICE_PROCESS_ID,
          callId: `startup-${fixture.id}`,
          turnId,
        });
        attempt.fail("spawn_failed");
        attempt.finish("failed", "unknown");

        if (order === "error-before-hook") {
          attempt.bind(speculative.id);
          fixture.ownership.captureError(new BridgeError("spawn_failed", turnId, false));
          await Promise.resolve();
          expect(recoveries).toBe(0);
          expect(outputText(fixture)).toBe("");
          await fixture.accept("accepted failure");
          expect(recoveries).toBe(0);
          fixture.ownership.admitEou(speculative.id);
        } else {
          await fixture.accept("accepted failure");
          fixture.ownership.admitEou(speculative.id);
          fixture.ownership.captureError(new BridgeError("spawn_failed", turnId, false));
          await Promise.resolve();
          expect(recoveries).toBe(0);
          attempt.bind(speculative.id);
        }

        await until(() => recoveries === 1 && !!fallback, `${order} owned recovery`);
        await fallback.waitForPlayout();
        expect(outputText(fixture)).toContain("S6_RECOVERY");
        expect(fixture.ownership.pendingErrorCount).toBe(0);
        expect(recoveries).toBe(1);
        expect(fixture.created).toHaveLength(2);
        expect(fixture.tts.streams).toHaveLength(1);
      } finally {
        await fixture.close();
      }
    },
  );

  it("S6 invalidates speculative A when distinct B is admitted and never revives A", async () => {
    const holdA = namedBarrier("s6-stale-a");
    const holdB = namedBarrier("s6-live-b");
    let recoveries = 0;
    const fixture = await pipeline("s6-stale-a-live-b", {
      llmPlans: [
        { turnId: "s6-stale-a", text: "STALE_A", holdBeforeText: holdA },
        { turnId: "s6-live-b", text: "LIVE_B", holdBeforeText: holdB },
      ],
      recover: async () => {
        recoveries += 1;
      },
    });
    try {
      const speechA = fixture.session.generateReply({ userInput: "turn A" });
      await fixture.llm.streams[0]!.entered.promise;
      const speechB = fixture.session.generateReply({ userInput: "turn B" });
      await fixture.llm.streams[1]!.entered.promise;
      await fixture.accept("turn B");
      fixture.ownership.admitEou(speechB.id);

      const turnA = randomUUID();
      const attemptA = fixture.trace.bridgeCreated({
        workerBootId: VOICE_PROCESS_ID,
        callId: `startup-${fixture.id}`,
        turnId: turnA,
      });
      fixture.ownership.captureError(new BridgeError("spawn_failed", turnA, false));
      attemptA.bind(speechA.id);
      fixture.ownership.admitEou(speechA.id);
      await Promise.resolve();

      expect(recoveries).toBe(0);
      expect(fixture.ownership.currentOwner?.creation.speechId).toBe(speechB.id);
      expect(fixture.ownership.pendingErrorCount).toBe(1);
      expect(fixture.created).toHaveLength(2);
      expect(recoveries).toBe(0);
    } finally {
      holdA.resolve();
      holdB.resolve();
      await fixture.close();
    }
  });

  it("S7 records explicit IDs for an opening without EOU and cancellation without a TTS metric", async () => {
    const held = namedBarrier("s7-opening-before-frame");
    const entered = namedBarrier("s7-tts-entered");
    const fixture = await pipeline("s7-diagnostics", {
      llmPlans: [
        { turnId: "s7-opening", text: "S7_STALE" },
        { turnId: "s7-replacement", text: "S7_REPLACEMENT" },
      ],
      ttsPlans: [{ mode: "hold-before-frame", entered, release: held }, { mode: "normal" }],
    });
    let closed = false;
    try {
      fixture.arbiter.answer();
      await entered.promise;
      await fixture.accept("s7 replacement");
      const replacement = fixture.session.generateReply({ userInput: "s7 replacement" });
      await replacement.waitForPlayout();
      held.resolve();
      await fixture.created[0]!.waitForPlayout();
      await fixture.close();
      closed = true;

      const opening = fixture.created[0]!;
      expect(fixture.rows).toContainEqual(
        expect.objectContaining({ event: "speech_started", speechId: opening.id, origin: "opening" }),
      );
      expect(fixture.rows).not.toContainEqual(expect.objectContaining({ event: "sdk_metric", metric: "eou" }));
      expect(fixture.rows).toContainEqual(
        expect.objectContaining({ event: "speech_terminal", speechId: opening.id, outcome: "cancelled" }),
      );
      expect(fixture.rows.filter((row) => row.event === "synthesis_terminal" && row.outcome === "cancelled")).toEqual([
        expect.objectContaining({ speechId: null, frameCount: 0 }),
      ]);
      expect(outputText(fixture)).toContain("S7_REPLACEMENT");
      expect(fixture.created).toHaveLength(2);
      expect(fixture.llm.streams).toHaveLength(2);
      expect(fixture.tts.streams).toHaveLength(2);
    } finally {
      held.resolve();
      if (!closed) await fixture.close();
    }
  });
});

function bridgeOrigin(trace: SpeechTrace, speechId: string, label: string) {
  const turnId = randomUUID();
  const attempt = trace.bridgeCreated({ workerBootId: VOICE_PROCESS_ID, callId: label, turnId });
  attempt.bind(speechId);
  attempt.fail("spawn_failed");
  attempt.finish("failed", "unknown");
  return turnId;
}

async function admittedOrigin(fixture: Pipeline, label: string): Promise<{ speech: SpeechHandle; turnId: string }> {
  fixture.llm.plans.unshift({ turnId: `${label}-origin-text`, text: `${label}_ORIGIN` });
  const speech = fixture.session.generateReply({ userInput: `${label} input` });
  await speech.waitForPlayout();
  await fixture.accept(`${label} input`);
  fixture.ownership.admitEou(speech.id);
  const turnId = bridgeOrigin(fixture.trace, speech.id, `startup-${fixture.id}`);
  return { speech, turnId };
}

function invalidate(trace: SpeechTrace, turnId: string, callId: string, mode: "conflict" | "eviction"): void {
  if (mode === "conflict") {
    trace.bindBridge(turnId, "conflicting-speech-id");
    return;
  }
  for (let index = 0; index < 256; index += 1) {
    const attempt = trace.bridgeCreated({ workerBootId: VOICE_PROCESS_ID, callId, turnId: randomUUID() });
    attempt.finish("completed", "unknown");
  }
  expect(trace.bridgeBinding(turnId)).toEqual({ state: "unavailable", reason: "evicted" });
}

describe("Task 6 retained recovery follow-through with public SDK handles", () => {
  it.each(["retry", "fallback"] as const)(
    "interrupts an already-queued owned %s on accepted input and progresses its replacement",
    async (kind) => {
      const staleGate = namedBarrier(`accepted-${kind}-stale-frame`);
      const staleEntered = namedBarrier(`accepted-${kind}-stale-entered`);
      let stale!: SpeechHandle;
      const fixture = await pipeline(`accepted-${kind}`, {
        llmPlans:
          kind === "retry"
            ? [
                { turnId: "accepted-stale-retry", text: "STALE_RECOVERY", holdBeforeText: staleGate },
                { turnId: "accepted-replacement", text: "ACCEPTED_REPLACEMENT" },
              ]
            : [{ turnId: "accepted-replacement", text: "ACCEPTED_REPLACEMENT" }],
        ttsPlans:
          kind === "fallback"
            ? [
                { mode: "normal" },
                { mode: "hold-before-frame", entered: staleEntered, release: staleGate },
                { mode: "normal" },
              ]
            : [],
        recover: async (chain, _error, actions, current) => {
          if (kind === "retry") {
            stale = actions.scheduleOwned("retry", () => current.session.generateReply(), chain);
            return;
          }
          stale = actions.scheduleOwned("fallback", () => current.session.say("STALE_RECOVERY"), chain);
          await actions.waitOwned(chain, () => stale.waitForPlayout());
        },
      });
      try {
        const origin = await admittedOrigin(fixture, `accepted-${kind}`);
        fixture.ownership.captureError(new BridgeError("spawn_failed", origin.turnId, false));
        await until(() => !!stale, `${kind} recovery handle`);
        if (kind === "retry") {
          await fixture.llm.streams.find((stream) => stream.plan.turnId === "accepted-stale-retry")!.entered.promise;
        } else {
          await staleEntered.promise;
        }

        await fixture.accept("accepted replacement");
        const replacement = fixture.session.generateReply({ userInput: "accepted replacement" });
        await replacement.waitForPlayout();
        staleGate.resolve();
        await stale.waitForPlayout();

        expect(stale.interrupted).toBe(true);
        expect(replacement.interrupted).toBe(false);
        expect(outputText(fixture)).not.toContain("STALE_RECOVERY");
        expect(outputText(fixture)).toContain("ACCEPTED_REPLACEMENT");
        expect(fixture.created).toHaveLength(3);
        expect(fixture.ownership.activeRecoveryCount).toBe(0);
      } finally {
        staleGate.resolve();
        await fixture.close();
      }
    },
  );

  it.each(["conflict", "eviction"] as const)(
    "cancels a post-routine retry after real-trace %s and lets an unrelated successor finish",
    async (mode) => {
      const retryGate = namedBarrier(`post-routine-${mode}-retry-frame`);
      let chainRef!: RecoveryChain<BridgeError>;
      let retry!: SpeechHandle;
      const fixture = await pipeline(`post-routine-${mode}`, {
        llmPlans: [
          { turnId: `post-${mode}-retry`, text: "STALE_RETRY", holdBeforeText: retryGate },
          { turnId: `post-${mode}-successor`, text: "HEALTHY_SUCCESSOR" },
        ],
        recover: async (chain, _error, actions, current) => {
          chainRef = chain;
          retry = actions.scheduleOwned("retry", () => current.session.generateReply(), chain);
        },
      });
      try {
        const origin = await admittedOrigin(fixture, `post-${mode}`);
        fixture.ownership.captureError(new BridgeError("spawn_failed", origin.turnId, false));
        await until(() => !!retry, "post-routine retry handle");
        await fixture.llm.streams.find((stream) => stream.plan.turnId === `post-${mode}-retry`)!.entered.promise;
        await until(() => fixture.ownership.activeRecoveryCount === 0, "recovery routine finally");
        expect(fixture.ownership.applicationHandleCount).toBe(1);

        invalidate(fixture.trace, origin.turnId, `startup-${fixture.id}`, mode);
        expect(chainRef.bindingInvalidationHandled).toBe(true);
        expect(retry.interrupted).toBe(true);
        retryGate.resolve();
        await retry.waitForPlayout();

        const successor = fixture.session.generateReply({ userInput: "unrelated successor" });
        await successor.waitForPlayout();
        expect(outputText(fixture)).not.toContain("STALE_RETRY");
        expect(outputText(fixture)).toContain("HEALTHY_SUCCESSOR");
        expect(
          fixture.rows.filter(
            (row) =>
              row.event === "diagnostic_gap" &&
              row.reason === "action_ownership_unproved" &&
              row.turnId === origin.turnId,
          ),
        ).toHaveLength(1);
        expect(fixture.ownership.applicationHandleCount).toBe(0);
        expect(fixture.created).toHaveLength(3);
      } finally {
        retryGate.resolve();
        await fixture.close();
      }
    },
  );

  it("keeps a valid duplicate binding and allows the post-routine retry frame", async () => {
    const retryGate = namedBarrier("post-routine-valid-retry-frame");
    let retry!: SpeechHandle;
    const fixture = await pipeline("post-routine-valid", {
      llmPlans: [{ turnId: "post-valid-retry", text: "VALID_RETRY", holdBeforeText: retryGate }],
      recover: async (chain, _error, actions, current) => {
        retry = actions.scheduleOwned("retry", () => current.session.generateReply(), chain);
      },
    });
    try {
      const origin = await admittedOrigin(fixture, "post-valid");
      fixture.ownership.captureError(new BridgeError("spawn_failed", origin.turnId, false));
      await until(() => !!retry, "valid retry handle");
      await until(() => fixture.ownership.activeRecoveryCount === 0, "valid recovery routine finally");
      fixture.trace.bindBridge(origin.turnId, origin.speech.id);
      expect(retry.interrupted).toBe(false);
      retryGate.resolve();
      await retry.waitForPlayout();
      expect(outputText(fixture)).toContain("VALID_RETRY");
      expect(fixture.created).toHaveLength(2);
    } finally {
      retryGate.resolve();
      await fixture.close();
    }
  });

  it.each(["conflict", "eviction"] as const)(
    "cancels a retained prior-aborted fallback after real-trace %s without reviving recovery",
    async (mode) => {
      const fallbackGate = namedBarrier(`prior-abort-${mode}-fallback-frame`);
      const fallbackEntered = namedBarrier(`prior-abort-${mode}-fallback-entered`);
      let chainRef!: RecoveryChain<BridgeError>;
      let fallback!: SpeechHandle;
      const fixture = await pipeline(`prior-abort-${mode}`, {
        llmPlans: [{ turnId: `prior-${mode}-speculative`, text: "SPECULATIVE" }],
        ttsPlans: [
          { mode: "normal" },
          { mode: "hold-before-frame", entered: fallbackEntered, release: fallbackGate },
          { mode: "normal" },
        ],
        recover: async (chain, _error, actions, current) => {
          chainRef = chain;
          fallback = actions.scheduleOwned("fallback", () => current.session.say("STALE_FALLBACK"), chain);
          await actions.waitOwned(chain, () => fallback.waitForPlayout());
        },
      });
      try {
        const origin = await admittedOrigin(fixture, `prior-${mode}`);
        fixture.ownership.captureError(new BridgeError("auth_failed", origin.turnId, false));
        await fallbackEntered.promise;
        const speculative = fixture.session.generateReply({ userInput: "speculative fence" });
        await until(() => chainRef.abort.signal.aborted, "prior-abort chain fenced");
        await until(() => fixture.ownership.activeRecoveryCount === 0, "prior-abort routine finally");
        expect(chainRef.bindingInvalidationHandled).toBe(false);
        expect(fallback.interrupted).toBe(false);

        invalidate(fixture.trace, origin.turnId, `startup-${fixture.id}`, mode);
        expect(chainRef.bindingInvalidationHandled).toBe(true);
        expect(fallback.interrupted).toBe(true);
        fallbackGate.resolve();
        await Promise.all([fallback.waitForPlayout(), speculative.waitForPlayout()]);

        expect(outputText(fixture)).not.toContain("STALE_FALLBACK");
        expect(outputText(fixture)).toContain("SPECULATIVE");
        expect(
          fixture.rows.filter(
            (row) =>
              row.event === "diagnostic_gap" &&
              row.reason === "action_ownership_unproved" &&
              row.turnId === origin.turnId,
          ),
        ).toHaveLength(1);
        expect(fixture.created).toHaveLength(3);
      } finally {
        fallbackGate.resolve();
        await fixture.close();
      }
    },
  );

  it("lets a retained prior-aborted fallback finish under a duplicate valid binding", async () => {
    const fallbackGate = namedBarrier("prior-abort-valid-fallback-frame");
    const fallbackEntered = namedBarrier("prior-abort-valid-fallback-entered");
    let chainRef!: RecoveryChain<BridgeError>;
    let fallback!: SpeechHandle;
    const fixture = await pipeline("prior-abort-valid", {
      llmPlans: [{ turnId: "prior-valid-speculative", text: "VALID_SUCCESSOR" }],
      ttsPlans: [
        { mode: "normal" },
        { mode: "hold-before-frame", entered: fallbackEntered, release: fallbackGate },
        { mode: "normal" },
      ],
      recover: async (chain, _error, actions, current) => {
        chainRef = chain;
        fallback = actions.scheduleOwned("fallback", () => current.session.say("VALID_FALLBACK"), chain);
        await actions.waitOwned(chain, () => fallback.waitForPlayout());
      },
    });
    try {
      const origin = await admittedOrigin(fixture, "prior-valid");
      fixture.ownership.captureError(new BridgeError("auth_failed", origin.turnId, false));
      await fallbackEntered.promise;
      const successor = fixture.session.generateReply({ userInput: "speculative fence" });
      await until(() => chainRef.abort.signal.aborted, "valid prior-abort chain fenced");
      await until(() => fixture.ownership.activeRecoveryCount === 0, "valid prior-abort routine finally");
      fixture.trace.bindBridge(origin.turnId, origin.speech.id);

      expect(chainRef.bindingInvalidationHandled).toBe(false);
      expect(fallback.interrupted).toBe(false);
      expect(fixture.ownership.chainOwns(chainRef)).toBe(false);
      fallbackGate.resolve();
      await Promise.all([fallback.waitForPlayout(), successor.waitForPlayout()]);
      expect(outputText(fixture)).toContain("VALID_FALLBACK");
      expect(outputText(fixture)).toContain("VALID_SUCCESSOR");
      expect(fixture.created).toHaveLength(3);
    } finally {
      fallbackGate.resolve();
      await fixture.close();
    }
  });
});

describe("S9 cleanup and privacy", () => {
  it("contains filtered and asynchronous writer failures and emits no sensitive diagnostic fields", async () => {
    const rows: VoiceDiagnosticEvent[] = [];
    const writer: VoiceTraceWriter = {
      write: (event) => rows.push(event),
      emit: (event) => rows.push(event),
      snapshot: () => ({
        ...COMPLETE_WRITES,
        attempted: rows.length + 2,
        acknowledged: rows.length,
        filtered: 1,
        failed: 1,
        complete: false,
      }),
      settleWrites: async () => ({
        ...COMPLETE_WRITES,
        attempted: rows.length + 2,
        acknowledged: rows.length,
        filtered: 1,
        failed: 1,
        complete: false,
      }),
    };
    const trace = new SpeechTrace({ callId: "s9-private-call", workerBootId: VOICE_PROCESS_ID, writer });
    trace.call({ event: "call_started", direction: "outbound" });
    trace.startupPending();
    const beforeLoss = trace.snapshot();
    trace.close("call_closed");
    const afterLoss = trace.snapshot();

    expect(beforeLoss.incomplete).toBe(0);
    expect(beforeLoss.incompleteObservations).toBe(1);
    expect(afterLoss.logging).toMatchObject({ filtered: 1, failed: 1, complete: false });
    expect(JSON.stringify(rows)).not.toMatch(/phone|token|tool|audio|transcript|destination/i);
    expect(afterLoss.registry).toEqual({
      activeSpeech: 0,
      recentSpeech: 0,
      activeBridge: 0,
      recentBridge: 0,
      activeSynthesis: 0,
      recentSynthesis: 0,
    });
    await expect(trace.settleWrites()).resolves.toMatchObject({ failed: 1, complete: false });
  });
});
