import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// The logger is mocked so the handler's info line is both silent AND
// controllable — the error-path test below makes it throw to exercise the
// KPR-122 in-process contract (a handler exception must never escape).
const fixtureLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("../logging/logger.js", () => ({ createLogger: () => fixtureLog }));

// Keep the REAL SDK (real `tool()`, real `createSdkMcpServer()` — so the
// construction assertions stay meaningful) and only widen the returned
// config with the tool definitions, which the SDK otherwise hides behind the
// McpServer instance. This is the only way to invoke the handler directly
// without a transport.
vi.mock("@anthropic-ai/claude-agent-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@anthropic-ai/claude-agent-sdk")>();
  return {
    ...actual,
    createSdkMcpServer: (opts: Parameters<typeof actual.createSdkMcpServer>[0]) =>
      Object.assign(actual.createSdkMcpServer(opts), { tools: opts.tools ?? [] }),
  };
});

import {
  clampFixtureDelay,
  buildFixtureResult,
  createVoiceFixtureMcpServer,
  VOICE_FIXTURE_DEFAULT_DELAY_MS,
  VOICE_FIXTURE_MAX_DELAY_MS,
} from "./voice-fixture-mcp-server.js";

/* eslint-disable @typescript-eslint/no-explicit-any */
function lookupHandler(): (args: any, extra?: unknown) => Promise<any> {
  const server = createVoiceFixtureMcpServer() as any;
  const t = server.tools.find((x: any) => x.name === "voice_fixture_lookup");
  if (!t) throw new Error("voice_fixture_lookup not registered");
  return t.handler;
}

describe("clampFixtureDelay (spec §7 / §11)", () => {
  it("defaults, clamps over-cap, floors, and never errors", () => {
    expect(clampFixtureDelay(undefined)).toBe(VOICE_FIXTURE_DEFAULT_DELAY_MS);
    expect(clampFixtureDelay(NaN)).toBe(VOICE_FIXTURE_DEFAULT_DELAY_MS);
    expect(clampFixtureDelay(99999)).toBe(VOICE_FIXTURE_MAX_DELAY_MS);
    expect(clampFixtureDelay(-5)).toBe(0);
    expect(clampFixtureDelay(1500.9)).toBe(1500);
  });
});

describe("buildFixtureResult (spec §6.2 orders_get template)", () => {
  it("is byte-stable with the default PO", () => {
    expect(buildFixtureResult()).toBe(
      "PO 45021 · Acme Hardware · Open\n" +
        "Ordered: Aug 1, 2026 · Promised: Aug 28, 2026 · Last receipt: Aug 12, 2026\n" +
        "Ship to: shop\n" +
        "Lines:\n" +
        "- 12 maple doors — 8 received, 4 open\n" +
        "- 6 drawer boxes — 0 received, 6 open\n" +
        "Notes: vendor quoted late Friday",
    );
  });
  it("echoes a caller-stated PO number without changing the data", () => {
    const out = buildFixtureResult("77-104");
    expect(out.startsWith("PO 77-104 · Acme Hardware · Open")).toBe(true);
    expect(out).toContain("maple doors");
  });
});

describe("createVoiceFixtureMcpServer", () => {
  it("constructs an in-process SDK server named voice-fixture with the one tool", () => {
    const server = createVoiceFixtureMcpServer() as any;
    expect(server.type).toBe("sdk");
    expect(server.name).toBe("voice-fixture");
    expect(server.tools.map((t: any) => t.name)).toEqual(["voice_fixture_lookup"]);
  });
});

// ── The handler itself (pre-PR R1: previously unexercised) ─────────────
describe("voice_fixture_lookup handler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("sleeps the DEFAULT delay and returns the canned body (no args)", async () => {
    const handler = lookupHandler();
    const p = handler({});

    // Still asleep at one tick short of the default delay.
    await vi.advanceTimersByTimeAsync(VOICE_FIXTURE_DEFAULT_DELAY_MS - 1);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    const res = await p;

    expect(res.isError).toBeFalsy();
    expect(res.content).toEqual([{ type: "text", text: buildFixtureResult() }]);
    // Spec §7 logging: duration + delayMs only, never the canned prose.
    expect(fixtureLog.info).toHaveBeenCalledWith("voice_fixture_lookup complete", {
      delayMs: VOICE_FIXTURE_DEFAULT_DELAY_MS,
      durationMs: expect.any(Number),
    });
    const logged = JSON.stringify(fixtureLog.info.mock.calls);
    expect(logged).not.toContain("Acme");
    expect(logged).not.toContain("maple doors");
  });

  it("clamps an over-cap delay and echoes the caller's PO", async () => {
    const handler = lookupHandler();
    const p = handler({ delayMs: 99999, poNumber: "77-104" });
    await vi.advanceTimersByTimeAsync(VOICE_FIXTURE_MAX_DELAY_MS);
    const res = await p;

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe(buildFixtureResult("77-104"));
    expect(fixtureLog.info).toHaveBeenCalledWith("voice_fixture_lookup complete", {
      delayMs: VOICE_FIXTURE_MAX_DELAY_MS,
      durationMs: expect.any(Number),
    });
  });

  it("returns immediately on a zero/negative delay", async () => {
    const handler = lookupHandler();
    const p = handler({ delayMs: -5 });
    await vi.advanceTimersByTimeAsync(0);
    const res = await p;
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe(buildFixtureResult());
  });

  it("KPR-122 contract: an internal throw becomes backend_unavailable / isError, never an escape", async () => {
    // The one realistic in-handler throw site: the completion log line.
    fixtureLog.info.mockImplementationOnce(() => {
      throw new Error("logger exploded");
    });
    const handler = lookupHandler();
    const p = handler({ delayMs: 10 });
    await vi.advanceTimersByTimeAsync(10);
    const res = await p;

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toContain("backend_unavailable");
    expect(res.content[0].text).toContain("logger exploded");
  });
});
