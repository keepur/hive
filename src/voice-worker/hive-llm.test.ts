import { initializeLogger, llm } from "@livekit/agents";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { formatSSEDone, formatSSETextChunk } from "../channels/voice/openai-translator.js";
import { VOICE_OUTAGE_SPOKEN_NOTICE } from "../outage/outage-notices.js";
import type { BridgeFailureClass } from "./error-map.js";
import { BridgeError, HiveLLM } from "./hive-llm.js";
import { applyInterruptionMarker } from "./interruption-marker.js";

beforeAll(() => {
  initializeLogger({ pretty: false, level: "silent" });
});

const STREAM_ID = "chatcmpl-test";
const MODEL = "hive";

function makeHive(bridgeUrl: string): HiveLLM {
  return new HiveLLM({
    bridgeUrl,
    bridgeToken: "test-bridge-token",
    hiveAgentId: "luna",
    callId: "call-test",
    goal: "help the caller",
    context: "pilot",
  });
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
  it("yields SSE deltas in order and records llmTtftMs", async () => {
    const stub = await listen((_req, res) => {
      _req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(formatSSETextChunk(STREAM_ID, "one", MODEL));
      res.write(formatSSETextChunk(STREAM_ID, "two", MODEL));
      res.write(formatSSETextChunk(STREAM_ID, "three", MODEL));
      res.end(formatSSEDone(STREAM_ID, MODEL));
    });
    openServers.push(stub.server);

    const hive = makeHive(stub.url);
    const { chunks, bridge } = await consumeTurn(hive, userCtx("hello"));
    expect(bridge).toBeUndefined();
    expect(chunks.map((c) => c.delta?.content)).toEqual(["one", "two", "three"]);
    expect(hive.lastTurnTiming).not.toBeNull();
    expect(hive.lastTurnTiming!.llmTtftMs).toBeGreaterThanOrEqual(0);
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

  it("records maxInterChunkGapMs when the engine pauses between deltas", async () => {
    const stub = await listen((_req, res) => {
      _req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(formatSSETextChunk(STREAM_ID, "one", MODEL));
      setTimeout(() => {
        res.write(formatSSETextChunk(STREAM_ID, "two", MODEL));
        res.end(formatSSEDone(STREAM_ID, MODEL));
      }, 80);
    });
    openServers.push(stub.server);

    const hive = makeHive(stub.url);
    const { chunks, bridge } = await consumeTurn(hive, userCtx("hello"));
    expect(bridge).toBeUndefined();
    expect(chunks.map((c) => c.delta?.content)).toEqual(["one", "two"]);
    expect(hive.lastTurnTiming!.maxInterChunkGapMs).toBeGreaterThan(0);
  });

  it("maps 503 Voice temporarily unavailable to budget_saturated", async () => {
    const stub = await listen((_req, res) => {
      _req.resume();
      res.writeHead(503, { "Content-Type": "text/plain" });
      res.end("Voice temporarily unavailable");
    });
    openServers.push(stub.server);

    const hive = makeHive(stub.url);
    const { bridge } = await consumeTurn(hive, userCtx("hello"));
    expectBridge(bridge, "budget_saturated", false);
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

    const hive = makeHive(stub.url);
    const { bridge } = await consumeTurn(hive, userCtx("hello"));
    expectBridge(bridge, "midstream_error", true);
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

    const hive = makeHive(stub.url);
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
  });

  it("publishes lastTurnTiming at the first yielded token before the stream ends", async () => {
    const stub = await listen((_req, res) => {
      _req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      res.write(formatSSETextChunk(STREAM_ID, "one", MODEL));
    });
    openServers.push(stub.server);

    const hive = makeHive(stub.url);
    hive.on("error", () => {
      /* swallow EventEmitter errors */
    });
    const stream = hive.chat({ chatCtx: userCtx("hello") });
    const first = await stream.next();
    expect(first.done).toBe(false);
    expect(first.value?.delta?.content).toBe("one");
    expect(hive.lastTurnTiming).not.toBeNull();
    expect(hive.lastTurnTiming!.llmTtftMs).toBeGreaterThanOrEqual(0);
    stream.close();
    const leftover: llm.ChatChunk[] = [];
    try {
      for await (const chunk of stream) leftover.push(chunk);
    } catch {
      /* close may reject the iterator */
    }
    expect(leftover).toEqual([]);
  });

  it("clears lastTurnTiming at run start so abort-before-token does not leak the prior turn", async () => {
    const stub = await listen((req, res) => {
      req.resume();
      res.writeHead(200, { "Content-Type": "text/event-stream" });
    });
    openServers.push(stub.server);

    const hive = makeHive(stub.url);
    const prior = { llmTtftMs: 999, maxInterChunkGapMs: 50 };
    hive.lastTurnTiming = prior;
    hive.on("error", () => {
      /* swallow EventEmitter errors */
    });
    const stream = hive.chat({ chatCtx: userCtx("hello") });
    const started = Date.now();
    while (hive.lastTurnTiming === prior) {
      if (Date.now() - started > 2000) break;
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(hive.lastTurnTiming).toBeNull();
    expect(hive.lastTurnTiming).not.toBe(prior);
    stream.close();
    const leftover: llm.ChatChunk[] = [];
    let thrown: unknown;
    try {
      for await (const chunk of stream) leftover.push(chunk);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeUndefined();
    expect(leftover).toEqual([]);
    expect(hive.lastTurnTiming).not.toBe(prior);
  });

  it("prefixes the latest user message with the interruption marker only", async () => {
    let parsedBody: {
      stream?: boolean;
      messages?: Array<{ role: string; content: string }>;
      call?: { id?: string; metadata?: Record<string, string> };
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
