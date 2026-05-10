import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { SmsAdapter } from "./sms-adapter.js";
import type { WorkItem, WorkResult } from "../types/work-item.js";

// --- Test fixtures -----------------------------------------------------------

function makeQuoConvResponse(participant: string) {
  return {
    data: [{ participants: [participant] }],
  };
}

function makeQuoMsgResponse(opts: {
  msgId: string;
  from: string;
  to: string;
  text: string;
  direction?: "incoming" | "outgoing";
}) {
  return {
    data: [
      {
        id: opts.msgId,
        from: opts.from,
        to: [opts.to],
        text: opts.text,
        direction: opts.direction ?? "incoming",
        createdAt: new Date().toISOString(),
      },
    ],
  };
}

function makeJsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: () => Promise.resolve(JSON.stringify(body)),
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

/**
 * Wires a fetch stub that recognizes:
 *   GET  /conversations           → conversations list
 *   GET  /messages                → message list (filtered to incoming by adapter)
 *   POST /messages                → outbound delivery (returns 200)
 *
 * Returns a `outboundCalls` array so tests can assert on Quo delivery payloads.
 */
function wireQuoFetch(opts: { participant: string; msgId: string; text: string; lineNumber: string }) {
  const outboundCalls: Array<{ url: string; body: any }> = [];

  const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
    const u = String(url);
    const method = init?.method ?? "GET";

    if (method === "POST" && u.includes("/messages")) {
      outboundCalls.push({ url: u, body: JSON.parse(String(init!.body)) });
      return makeJsonResponse({ ok: true });
    }
    if (u.includes("/conversations")) {
      return makeJsonResponse(makeQuoConvResponse(opts.participant));
    }
    if (u.includes("/messages")) {
      return makeJsonResponse(
        makeQuoMsgResponse({
          msgId: opts.msgId,
          from: opts.participant,
          to: opts.lineNumber,
          text: opts.text,
        }),
      );
    }
    throw new Error(`Unexpected fetch: ${method} ${u}`);
  });

  vi.stubGlobal("fetch", fetchStub);
  return { fetchStub, outboundCalls };
}

const lineFixture = {
  id: "PN_LINE_1",
  label: "May (CEO)",
  number: "+15550000001",
  slackChannel: "quo-may",
};

// Helper: wait until a predicate is true, polling at short intervals.
// Used because poll() runs as fire-and-forget on adapter start.
async function waitFor(pred: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

// ---------------------------------------------------------------------------
// Tests — KPR-223 simplified the adapter to a thin translator: poll Quo,
// emit WorkItems via onWorkItem, deliver via Quo POST. Per-turn-spawn
// branching now lives entirely inside the dispatcher.
// ---------------------------------------------------------------------------

describe("SmsAdapter", () => {
  let stoppers: Array<() => Promise<void>> = [];

  beforeEach(() => {
    vi.clearAllMocks();
    stoppers = [];
  });

  afterEach(async () => {
    for (const stop of stoppers) await stop();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  describe("poll() emits WorkItems via onWorkItem", () => {
    it("emits a WorkItem for each incoming message", async () => {
      const { fetchStub } = wireQuoFetch({
        participant: "+15551112222",
        msgId: "MSG_1",
        text: "hi",
        lineNumber: lineFixture.number,
      });

      const adapter = new SmsAdapter("quo-key-x", [lineFixture]);
      stoppers.push(() => adapter.stop());

      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      // poll() runs immediately on start.
      await waitFor(() => onWorkItem.mock.calls.length > 0);

      expect(onWorkItem).toHaveBeenCalledTimes(1);
      const item = onWorkItem.mock.calls[0]![0] as WorkItem;
      expect(item.source.kind).toBe("sms");
      expect(item.source.id).toBe(lineFixture.id);
      expect(item.text).toContain("hi");
      expect(item.threadId).toBe(`sms:${lineFixture.id}:+15551112222`);

      // Conversations + messages both fetched; no POST yet (delivery is the dispatcher's job).
      const calls = fetchStub.mock.calls.map((c) => String(c[0]));
      expect(calls.some((u) => u.includes("/conversations"))).toBe(true);
      expect(calls.some((u) => u.includes("/messages") && !u.includes("?"))).toBe(false);
    });

    it("uses slackChannel as the routing label when provided", async () => {
      wireQuoFetch({
        participant: "+15553334444",
        msgId: "MSG_2",
        text: "ping",
        lineNumber: lineFixture.number,
      });

      const adapter = new SmsAdapter("quo-key-y", [lineFixture]);
      stoppers.push(() => adapter.stop());

      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);
      await waitFor(() => onWorkItem.mock.calls.length > 0);

      const item = onWorkItem.mock.calls[0]![0] as WorkItem;
      // routeLabel = slackChannel (lineFixture.slackChannel === "quo-may").
      expect(item.source.label).toBe("quo-may");
    });
  });

  describe("deliver() (Quo POST shape)", () => {
    it("posts to /messages with from=phoneNumberId, to=[sender], content=text", async () => {
      const { outboundCalls } = wireQuoFetch({
        participant: "x",
        msgId: "x",
        text: "x",
        lineNumber: lineFixture.number,
      });
      const adapter = new SmsAdapter("qk", [lineFixture]);
      const result: WorkResult = {
        text: "hi back",
        agentId: "agent-a",
        workItem: {
          id: "MSG_DELIVER_1",
          text: "ignored",
          source: { kind: "sms", id: lineFixture.id, label: lineFixture.label },
          sender: "+15554443333",
          threadId: `sms:${lineFixture.id}:+15554443333`,
          timestamp: new Date(),
        },
        costUsd: 0,
        durationMs: 0,
      };
      await adapter.deliver(result);

      expect(outboundCalls).toHaveLength(1);
      expect(outboundCalls[0]!.body).toEqual({
        from: lineFixture.id,
        to: ["+15554443333"],
        content: "hi back",
      });
    });

    it("skips delivery when result.error is set", async () => {
      const { outboundCalls } = wireQuoFetch({
        participant: "x",
        msgId: "x",
        text: "x",
        lineNumber: lineFixture.number,
      });
      const adapter = new SmsAdapter("qk", [lineFixture]);
      await adapter.deliver({
        text: "should not send",
        agentId: "agent-a",
        workItem: {
          id: "ERR1",
          text: "x",
          source: { kind: "sms", id: lineFixture.id, label: lineFixture.label },
          sender: "+15550000099",
          threadId: "t",
          timestamp: new Date(),
        },
        costUsd: 0,
        durationMs: 0,
        error: "agent crashed",
      });
      expect(outboundCalls).toHaveLength(0);
    });
  });
});
