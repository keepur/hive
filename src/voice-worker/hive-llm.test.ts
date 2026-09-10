import { initializeLogger, llm } from "@livekit/agents";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatSSEDone, formatSSETextChunk } from "../channels/voice/openai-translator.js";
import { VOICE_OUTAGE_SPOKEN_NOTICE } from "../outage/outage-notices.js";
import {
  VOICE_PROCESS_ID,
  type VoiceDiagnosticEvent,
  type VoiceTraceWriteCounts,
  type VoiceTraceWriter,
} from "../voice/voice-trace.js";
import type { BridgeFailureClass } from "./error-map.js";
import { BridgeError, HiveLLM, type HiveLLMStream } from "./hive-llm.js";
import { applyInterruptionMarker } from "./interruption-marker.js";
import { SpeechTrace } from "./speech-trace.js";

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

const STREAM_ID = "chatcmpl-test";
const MODEL = "hive";

function gate<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function until(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

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

function traceHarness(callId = "call-test") {
  const rows: VoiceDiagnosticEvent[] = [];
  const writer: VoiceTraceWriter = {
    write: (event) => rows.push(event),
    emit: (event) => rows.push(event),
    snapshot: () => ({ ...COMPLETE_WRITES, attempted: rows.length, acknowledged: rows.length }),
    settleWrites: async () => ({ ...COMPLETE_WRITES, attempted: rows.length, acknowledged: rows.length }),
  };
  return { rows, trace: new SpeechTrace({ callId, workerBootId: VOICE_PROCESS_ID, writer }) };
}

function makeHive(bridgeUrl: string, trace = traceHarness().trace): HiveLLM {
  return new HiveLLM({
    bridgeUrl,
    bridgeToken: "test-bridge-token",
    hiveAgentId: "luna",
    callId: "call-test",
    goal: "help the caller",
    context: "pilot",
    trace,
  });
}

function bridgeRows(rows: VoiceDiagnosticEvent[]) {
  return rows.filter((row) => row.event.startsWith("bridge_"));
}

function terminalRows(rows: VoiceDiagnosticEvent[]) {
  return rows.filter((row) => row.event === "bridge_terminal");
}

async function drainStream(stream: HiveLLMStream): Promise<llm.ChatChunk[]> {
  const chunks: llm.ChatChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function userCtx(...texts: string[]): llm.ChatContext {
  const chatCtx = new llm.ChatContext();
  for (const text of texts) chatCtx.addMessage({ role: "user", content: text });
  return chatCtx;
}

async function listen(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ url: string; port: number; server: Server; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const addr = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${addr.port}/v1/chat/completions`,
    port: addr.port,
    server,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.closeAllConnections();
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

async function consumeTurn(hive: HiveLLM, chatCtx: llm.ChatContext) {
  let eventError: BridgeError | undefined;
  const onErr = (ev: { error: Error }) => {
    if (ev.error instanceof BridgeError) eventError = ev.error;
  };
  hive.on("error", onErr);
  const chunks: llm.ChatChunk[] = [];
  let thrown: unknown;
  try {
    for await (const chunk of hive.chat({ chatCtx })) {
      chunks.push(chunk);
    }
  } catch (err) {
    thrown = err;
  } finally {
    hive.off("error", onErr);
  }
  const bridge = thrown instanceof BridgeError ? thrown : eventError;
  return { chunks, thrown, eventError, bridge };
}

function expectBridge(bridge: BridgeError | undefined, failureClass: BridgeFailureClass, bytesReceived?: boolean) {
  expect(bridge).toBeInstanceOf(BridgeError);
  expect(bridge!.failureClass).toBe(failureClass);
  if (bytesReceived !== undefined) expect(bridge!.bytesReceived).toBe(bytesReceived);
}

const openServers: Server[] = [];

afterEach(async () => {
  while (openServers.length > 0) {
    const server = openServers.pop()!;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

describe("HiveLLM (KPR-322)", () => {
  it("marks only its exact recorded BridgeError recoverable before later listeners run", () => {
    const hive = makeHive("http://127.0.0.1:9/v1/chat/completions");
    const owned = new BridgeError("engine_unreachable", "turn-owned", false);
    const unrelated = new BridgeError("engine_unreachable", "turn-other", false);
    const observed: boolean[] = [];
    hive.on("error", (event) => observed.push(event.recoverable));

    hive.ownFailure(owned);
    hive.emit("error", {
      type: "llm_error",
      timestamp: Date.now(),
      label: "hive-llm",
      error: owned,
      recoverable: false,
    });
    hive.emit("error", {
      type: "llm_error",
      timestamp: Date.now(),
      label: "other",
      error: unrelated,
      recoverable: false,
    });

    expect(observed).toEqual([true, false]);
  });

  it("allocates immutable turn identity before run and streams every nonempty delta under it", async () => {
    const stub = await listen((_req, res) => {
      _req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(formatSSETextChunk(STREAM_ID, "", MODEL));
      res.write(formatSSETextChunk(STREAM_ID, "one", MODEL));
      res.write(formatSSETextChunk(STREAM_ID, "two", MODEL));
      res.write(formatSSETextChunk(STREAM_ID, "three", MODEL));
      res.end(formatSSEDone(STREAM_ID, MODEL));
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    const stream = hive.chat({ chatCtx: userCtx("hello") });
    expect(Object.isFrozen(stream.traceContext)).toBe(true);
    expect(stream.traceContext.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(bridgeRows(rows).map((row) => row.event)).toEqual(["bridge_created"]);

    const chunks = await drainStream(stream);
    expect(chunks.map((c) => c.delta?.content)).toEqual(["one", "two", "three"]);
    expect(new Set(chunks.map((chunk) => chunk.id))).toEqual(new Set([`hive-${stream.traceContext.turnId}`]));
    expect(terminalRows(rows)).toHaveLength(1);
    expect(terminalRows(rows)[0]).toMatchObject({
      turnId: stream.traceContext.turnId,
      outcome: "completed",
      textLength: 11,
      firstTextMs: { reason: null },
      maximumGapMs: { reason: null },
    });
  });

  it("passthrough: 200 spoken outage notice streams as content (not a BridgeError)", async () => {
    const stub = await listen((_req, res) => {
      _req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(formatSSETextChunk(STREAM_ID, VOICE_OUTAGE_SPOKEN_NOTICE, MODEL));
      res.end(formatSSEDone(STREAM_ID, MODEL));
    });
    openServers.push(stub.server);

    const hive = makeHive(stub.url);
    const { chunks, bridge } = await consumeTurn(hive, userCtx("hello"));
    expect(bridge).toBeUndefined();
    expect(chunks.map((c) => c.delta?.content)).toEqual([VOICE_OUTAGE_SPOKEN_NOTICE]);
  });

  it("records a maximum gap only after the second nonempty content chunk", async () => {
    const firstWritten = gate();
    const releaseSecond = gate();
    const stub = await listen((_req, res) => {
      _req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(formatSSETextChunk(STREAM_ID, "one", MODEL));
      firstWritten.resolve();
      void releaseSecond.promise.then(() => {
        res.write(formatSSETextChunk(STREAM_ID, "two", MODEL));
        res.end(formatSSEDone(STREAM_ID, MODEL));
      });
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    const stream = hive.chat({ chatCtx: userCtx("hello") });
    const first = await stream.next();
    expect(first.value?.delta?.content).toBe("one");
    await firstWritten.promise;
    await new Promise((resolve) => setTimeout(resolve, 10));
    releaseSecond.resolve();
    const chunks = [first.value!, ...(await drainStream(stream))];
    expect(chunks.map((c) => c.delta?.content)).toEqual(["one", "two"]);
    const terminal = terminalRows(rows)[0]!;
    expect(terminal.event).toBe("bridge_terminal");
    if (terminal.event !== "bridge_terminal") throw new Error("unreachable");
    expect(terminal.maximumGapMs?.value).toBeGreaterThan(0);
  });

  it("maps 503 Voice temporarily unavailable to budget_saturated", async () => {
    const stub = await listen((_req, res) => {
      _req.resume();
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Voice temporarily unavailable");
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    const { bridge } = await consumeTurn(hive, userCtx("hello"));
    expectBridge(bridge, "budget_saturated", false);
    expect(bridge?.message).toBe("Hive voice bridge request failed");
    expect(bridge?.message).not.toContain("Voice temporarily unavailable");
    expect(terminalRows(rows)).toEqual([
      expect.objectContaining({
        turnId: bridge?.turnId,
        status: 503,
        outcome: "failed",
        errorClass: "budget_saturated",
      }),
    ]);
  });

  it("maps 401 to bridge_auth", async () => {
    const stub = await listen((_req, res) => {
      _req.resume();
      res.writeHead(401, { "Content-Type": "text/plain" });
      res.end("unauthorized");
    });
    openServers.push(stub.server);

    const hive = makeHive(stub.url);
    const { bridge } = await consumeTurn(hive, userCtx("hello"));
    expectBridge(bridge, "bridge_auth", false);
  });

  it("maps connection refused to engine_unreachable", async () => {
    const stub = await listen(() => {
      /* never reached */
    });
    const url = stub.url;
    await stub.close();

    const hive = makeHive(url);
    const { bridge } = await consumeTurn(hive, userCtx("hello"));
    expectBridge(bridge, "engine_unreachable", false);
  });

  it("maps a mid-stream socket destroy to midstream_error with bytesReceived", async () => {
    const stub = await listen((_req, res) => {
      _req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(formatSSETextChunk(STREAM_ID, "one", MODEL), () => {
        // Let the client read delta 1 before tearing the socket down; an
        // immediate destroy races fetch and classifies as engine_unreachable.
        setTimeout(() => res.destroy(), 30);
      });
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    const { bridge } = await consumeTurn(hive, userCtx("hello"));
    expectBridge(bridge, "midstream_error", true);
    expect(terminalRows(rows)).toEqual([
      expect.objectContaining({
        turnId: bridge?.turnId,
        outcome: "failed",
        errorClass: "midstream_error",
        textLength: 3,
        firstTextMs: { value: expect.any(Number), reason: null },
        maximumGapMs: { value: null, reason: "not_applicable" },
      }),
    ]);
  });

  it("aborts the HTTP request on stream.close() without throwing", async () => {
    let sawTeardown = false;
    let mark = (): void => {};
    const teardown = new Promise<void>((resolve) => {
      mark = () => {
        if (sawTeardown) return;
        sawTeardown = true;
        resolve();
      };
    });

    const stub = await listen((req, res) => {
      req.resume();
      req.on("close", mark);
      req.on("aborted", mark);
      res.on("close", mark);
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(formatSSETextChunk(STREAM_ID, "one", MODEL));
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    hive.on("error", () => {
      /* swallow EventEmitter errors */
    });
    const stream = hive.chat({ chatCtx: userCtx("hello") });
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(first.value?.delta?.content).toBe("one");
    stream.close();
    const leftover: llm.ChatChunk[] = [];
    let thrown: unknown;
    try {
      for await (const chunk of stream) leftover.push(chunk);
    } catch (err) {
      thrown = err;
    }
    await teardown;
    expect(thrown).toBeUndefined();
    expect(leftover).toEqual([]);
    expect(sawTeardown).toBe(true);
    expect(terminalRows(rows)).toEqual([
      expect.objectContaining({
        outcome: "cancelled",
        cause: "framework_cancelled",
        textLength: 3,
        firstTextMs: { value: expect.any(Number), reason: null },
      }),
    ]);
  });

  it("close immediately after construction terminalizes once and never starts fetch", async () => {
    let requests = 0;
    const stub = await listen((_req, res) => {
      requests += 1;
      res.end();
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    const stream = hive.chat({ chatCtx: userCtx("hello") });
    const turnId = stream.traceContext.turnId;
    stream.close();
    expect(await drainStream(stream)).toEqual([]);
    await new Promise((resolve) => setImmediate(resolve));

    expect(requests).toBe(0);
    expect(terminalRows(rows)).toEqual([
      expect.objectContaining({ turnId, outcome: "cancelled", cause: "framework_cancelled" }),
    ]);
  });

  it("terminalizes a stream construction failure under its preallocated turn identity", () => {
    const { trace, rows } = traceHarness();
    const hive = makeHive("http://127.0.0.1:1/v1/chat/completions", trace);

    expect(() =>
      hive.chat({
        chatCtx: userCtx("hello"),
        toolCtx: { invalid: {} } as never,
      }),
    ).toThrow(/anonymous function tool/);

    const created = bridgeRows(rows).find((row) => row.event === "bridge_created")!;
    expect(created.turnId).toMatch(/^[0-9a-f-]{36}$/);
    expect(terminalRows(rows)).toEqual([
      expect.objectContaining({
        turnId: created.turnId,
        outcome: "failed",
        errorClass: "stream_construction_failed",
      }),
    ]);
  });

  it("aborts the loopback request immediately while waiting for response headers", async () => {
    const received = gate();
    const closed = gate();
    const stub = await listen((req, res) => {
      req.resume();
      res.once("close", () => closed.resolve());
      received.resolve();
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    const stream = hive.chat({ chatCtx: userCtx("hello") });
    await received.promise;
    stream.close();
    await closed.promise;
    expect(await drainStream(stream)).toEqual([]);
    expect(terminalRows(rows)).toEqual([
      expect.objectContaining({
        turnId: stream.traceContext.turnId,
        outcome: "cancelled",
        status: undefined,
        firstTextMs: { value: null, reason: "not_reached" },
        maximumGapMs: { value: null, reason: "not_reached" },
      }),
    ]);
  });

  it("aborts after headers and before text without inventing content timing", async () => {
    const headers = gate();
    const closed = gate();
    const stub = await listen((req, res) => {
      req.resume();
      res.once("close", () => closed.resolve());
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.flushHeaders();
      headers.resolve();
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    const stream = hive.chat({ chatCtx: userCtx("hello") });
    await headers.promise;
    await until(() => bridgeRows(rows).some((row) => row.event === "bridge_response"), "bridge response status");
    stream.close();
    await closed.promise;
    expect(await drainStream(stream)).toEqual([]);
    expect(terminalRows(rows)).toEqual([
      expect.objectContaining({
        outcome: "cancelled",
        status: 200,
        textLength: 0,
        firstTextMs: { value: null, reason: "not_reached" },
        maximumGapMs: { value: null, reason: "not_reached" },
      }),
    ]);
  });

  it("records an empty successful stream without minting first-text timing", async () => {
    const stub = await listen((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.end(formatSSEDone(STREAM_ID, MODEL));
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    const stream = hive.chat({ chatCtx: userCtx("hello") });
    expect(await drainStream(stream)).toEqual([]);
    expect(terminalRows(rows)).toEqual([
      expect.objectContaining({
        turnId: stream.traceContext.turnId,
        outcome: "completed",
        status: 200,
        textLength: 0,
        firstTextMs: { value: null, reason: "not_reached" },
        maximumGapMs: { value: null, reason: "not_reached" },
      }),
    ]);
  });

  it("keeps a completed bridge terminal when close follows body completion", async () => {
    const releaseDone = gate();
    const stub = await listen((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(formatSSETextChunk(STREAM_ID, "done", MODEL));
      void releaseDone.promise.then(() => res.end(formatSSEDone(STREAM_ID, MODEL)));
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    const stream = hive.chat({ chatCtx: userCtx("hello") });
    const first = await stream.next();
    expect(first.value?.delta?.content).toBe("done");
    expect(terminalRows(rows)).toEqual([]);
    releaseDone.resolve();
    expect(await drainStream(stream)).toEqual([]);
    stream.close();
    expect(terminalRows(rows)).toEqual([
      expect.objectContaining({ turnId: stream.traceContext.turnId, outcome: "completed" }),
    ]);
  });

  it("keeps overlapping bridge identities separate when responses complete in reverse order", async () => {
    const responders = new Map<string, ServerResponse>();
    const receivedBoth = gate();
    const requestTurns = new Map<string, string>();
    const stub = await listen((req, res) => {
      const body: Buffer[] = [];
      req.on("data", (chunk: Buffer) => body.push(chunk));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(body).toString("utf8")) as {
          messages: Array<{ content: string }>;
          metadata: { voiceTrace: { turnId: string } };
        };
        const text = parsed.messages[0]!.content;
        requestTurns.set(text, parsed.metadata.voiceTrace.turnId);
        responders.set(text, res);
        if (responders.size === 2) receivedBoth.resolve();
      });
    });
    openServers.push(stub.server);

    const { trace, rows } = traceHarness();
    const hive = makeHive(stub.url, trace);
    const first = hive.chat({ chatCtx: userCtx("first") });
    const second = hive.chat({ chatCtx: userCtx("second") });
    const firstDone = drainStream(first);
    const secondDone = drainStream(second);
    await receivedBoth.promise;

    responders.get("second")!.writeHead(200, { "Content-Type": "text/event-stream" });
    responders.get("second")!.end(formatSSETextChunk(STREAM_ID, "two", MODEL) + formatSSEDone(STREAM_ID, MODEL));
    expect((await secondDone).map((chunk) => chunk.delta?.content)).toEqual(["two"]);
    responders.get("first")!.writeHead(200, { "Content-Type": "text/event-stream" });
    responders.get("first")!.end(formatSSETextChunk(STREAM_ID, "one", MODEL) + formatSSEDone(STREAM_ID, MODEL));
    expect((await firstDone).map((chunk) => chunk.delta?.content)).toEqual(["one"]);

    expect(requestTurns.get("first")).toBe(first.traceContext.turnId);
    expect(requestTurns.get("second")).toBe(second.traceContext.turnId);
    expect(first.traceContext.turnId).not.toBe(second.traceContext.turnId);
    expect(terminalRows(rows).map((row) => row.turnId)).toEqual([
      second.traceContext.turnId,
      first.traceContext.turnId,
    ]);

    trace.bindBridge(first.traceContext.turnId, "speech-first");
    trace.bindBridge(second.traceContext.turnId, "speech-second");
    expect(rows.filter((row) => row.event === "bridge_bound")).toEqual([
      expect.objectContaining({ turnId: first.traceContext.turnId, speechId: "speech-first" }),
      expect.objectContaining({ turnId: second.traceContext.turnId, speechId: "speech-second" }),
    ]);
  });

  it("prefixes the latest user message with the interruption marker only", async () => {
    let parsedBody: {
      stream?: boolean;
      messages?: Array<{ role: string; content: string }>;
      call?: { id?: string; metadata?: Record<string, string> };
      metadata?: {
        voiceTrace?: { schemaVersion?: number; workerBootId?: string; turnId?: string };
      };
    } = {};
    let auth = "";

    const stub = await listen((req, res) => {
      auth = String(req.headers.authorization ?? "");
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as typeof parsedBody;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(formatSSETextChunk(STREAM_ID, "ok", MODEL));
        res.end(formatSSEDone(STREAM_ID, MODEL));
      });
    });
    openServers.push(stub.server);

    const hive = makeHive(stub.url);
    const spoken = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
    hive.interruptedSpokenText = spoken;
    const chatCtx = new llm.ChatContext();
    chatCtx.addMessage({ role: "user", content: "first turn" });
    chatCtx.addMessage({ role: "assistant", content: "previous reply" });
    chatCtx.addMessage({ role: "user", content: "latest user" });

    const { bridge } = await consumeTurn(hive, chatCtx);
    expect(bridge).toBeUndefined();
    expect(auth).toBe("Bearer test-bridge-token");
    expect(parsedBody.stream).toBe(true);
    expect(parsedBody.call).toEqual({
      id: "call-test",
      metadata: { hive_agent_id: "luna", goal: "help the caller", context: "pilot" },
    });
    expect(parsedBody.metadata?.voiceTrace).toEqual({
      schemaVersion: 2,
      workerBootId: VOICE_PROCESS_ID,
      turnId: expect.stringMatching(/^[0-9a-f-]{36}$/),
    });
    expect(parsedBody.call?.metadata).not.toHaveProperty("voiceTrace");
    const msgs = parsedBody.messages ?? [];
    expect(msgs).toHaveLength(3);
    expect(msgs[0]).toEqual({ role: "user", content: "first turn" });
    expect(msgs[1]).toEqual({ role: "assistant", content: "previous reply" });
    expect(msgs[2]!.content).toBe(applyInterruptionMarker("latest user", spoken));
    expect(hive.interruptedSpokenText).toBeNull();
  });

  it("keeps the interruption marker on a 503 retry until the bridge POST succeeds", async () => {
    const bodies: Array<Array<{ role: string; content: string }>> = [];
    let requestCount = 0;

    const stub = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
          messages?: Array<{ role: string; content: string }>;
        };
        bodies.push(parsed.messages ?? []);
        requestCount += 1;
        if (requestCount === 1) {
          res.writeHead(503, { "Content-Type": "text/plain" });
          res.end("Voice temporarily unavailable");
          return;
        }
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(formatSSETextChunk(STREAM_ID, "ok", MODEL));
        res.end(formatSSEDone(STREAM_ID, MODEL));
      });
    });
    openServers.push(stub.server);

    const hive = makeHive(stub.url);
    const spoken = "alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron";
    hive.interruptedSpokenText = spoken;
    const chatCtx = userCtx("latest user");
    const marked = applyInterruptionMarker("latest user", spoken);

    const first = await consumeTurn(hive, chatCtx);
    expectBridge(first.bridge, "budget_saturated", false);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]![0]!.content).toBe(marked);
    expect(hive.interruptedSpokenText).toBe(spoken);

    const second = await consumeTurn(hive, chatCtx);
    expect(second.bridge).toBeUndefined();
    expect(bodies).toHaveLength(2);
    expect(bodies[1]![0]!.content).toBe(marked);
    expect(hive.interruptedSpokenText).toBeNull();
  });

  it("KPR-324 S1: POST body carries no tools key (tool_use never crosses the bridge)", async () => {
    // Capture idiom matches the interruption-marker test above: accumulate the
    // request body off the local HTTP stub's `data`/`end` events. There is no
    // fetch-init spy in this file.
    let parsedBody: Record<string, unknown> | undefined;

    const stub = await listen((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        parsedBody = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.write(formatSSETextChunk(STREAM_ID, "ok", MODEL));
        res.end(formatSSEDone(STREAM_ID, MODEL));
      });
    });
    openServers.push(stub.server);

    const hive = makeHive(stub.url);
    const { chunks, bridge } = await consumeTurn(hive, userCtx("hello"));
    expect(bridge).toBeUndefined();
    expect(chunks.map((c) => c.delta?.content)).toEqual(["ok"]);

    // Guard the guard: prove the body was actually captured, so the two
    // negative assertions below cannot pass vacuously on an undefined body.
    expect(parsedBody).toBeDefined();
    const body = parsedBody!;
    expect(body).toHaveProperty("messages");
    expect(body).not.toHaveProperty("tools");
    expect(body).not.toHaveProperty("tool_choice");
  });
});
