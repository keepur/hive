/**
 * KPR-465 R6: the engine bench driven against the REAL VoiceAdapter over
 * loopback HTTP — a local in-process adapter with a scripted fake spawn (no
 * instance, no model). Pins the worker-shaped request, the two barge-in
 * closes, the drills, and that result rows stay content-free.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Same file-level mocks as src/channels/voice/voice-adapter.integration.test.ts (logger, SDK, prompt-builder, config).
const mockLog = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  writeTracked: vi.fn(
    (_level: string, _msg: string, _data: Record<string, unknown> | undefined, callback: (result: string) => void) =>
      callback("acknowledged"),
  ),
  trackedSinkSnapshot: vi.fn(() => ({ sinkErrors: 0 })),
}));
vi.mock("../src/logging/logger.js", () => ({ createLogger: () => mockLog }));

// Stub the SDK — the per-turn-via-AgentManager path doesn't reach `query()`,
// but the import at the top of voice-adapter.ts does.
vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: vi.fn(),
}));

vi.mock("../src/agents/prompt-builder.js", () => ({
  buildVoiceSystemPrompt: vi.fn(async (_a: any, _m: any, ctx: any) => {
    return `voice-prompt:${ctx?.goal ?? ""}:${ctx?.context ?? ""}`;
  }),
}));

const configRef = {
  current: {
    anthropic: { apiKey: "test-key" },
    voice: { assistants: {} } as { assistants: Record<string, string>; bridgeToken?: string; port?: number },
  },
};
vi.mock("../src/config.js", () => ({
  get config() {
    return configRef.current;
  },
}));

import {
  BRIDGE_TOKEN,
  FIXTURE_AGENT_ID,
  engineRows,
  makeAdapter,
  startAdapter,
} from "../src/channels/voice/testing/adapter-fixture.js";
import {
  loopbackBaseUrlError,
  main,
  parseCallCount,
  postTurn,
  resolveCallsCount,
  runBenchCall,
  type BenchOptions,
} from "./voice-engine-bench.js";
import { BENCH_SCRIPT } from "../src/voice/voice-bench-script.js";
import type { TurnContext, TurnResult } from "../src/agents/agent-manager.js";

const CANNED: Record<number, string> = {
  1: "Hi, this is the bench agent.",
  2: "A leap year has 366 days.",
  3: "The capital of Japan is Tokyo.",
  4: "There are 180 minutes in three hours.",
  5: "A leap year exists because the orbit takes about 365 and a quarter days, so the calendar would drift; adding a day in February every four years fixes it.",
  6: "The number was 366.",
  7: "I searched and found no results for that phrase.",
  8: "Zero results.",
  9: "A hexagon has six sides.",
  10: "Goodbye, take care.",
};
const GOAL = "GOAL-SENTINEL-R6";
const CONTEXT = "CONTEXT-SENTINEL-R6";
/** Upper bound on a hold that only a barge-in should end; reaching it means the barge-in never fired. */
const HOLD_CAP_MS = 5_000;
/** Words of turn 5 streamed before the mid-answer stall the 300 ms barge-in lands in. */
const LONG_TURN_WORDS_BEFORE_STALL = 5;
/** How long the fake operator stays at the kill prompt after the engine has already finished the drilled turn. */
const OPERATOR_HOLD_MS = 200;

function turnIndexOf(ctx: TurnContext): number {
  const last = ctx.voicePrompt?.latestUserMessage ?? ctx.workItem.text;
  return BENCH_SCRIPT.find((t) => last.includes(t.text))?.index ?? 1;
}

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Resolves after `ms`, or as soon as the per-request signal aborts (the adapter aborts it when the caller closes). */
function holdUnlessAborted(signal: AbortSignal | undefined, ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

/**
 * Scripted stand-in for AgentManager.spawnTurn. Models what the bench's two
 * barge-ins need from a real turn: the long answer (5) is still mid-sentence
 * 300 ms after its first text (it stalls after a few words), and the first
 * lookup (7) is still inside its tool wait at 1.5 s. Like the real manager
 * (request close → ticket abort), a closed request ends the turn with an
 * `aborted` result, which the adapter records as a `cancelled` attempt. The
 * stalls end on that abort, never on a race against a streaming write.
 */
function scriptedSpawn(delayMs = 20) {
  return async (ctx: TurnContext, onStream?: (c: string) => void): Promise<TurnResult> => {
    const i = turnIndexOf(ctx);
    const signal = ctx.voiceRequestSignal;
    const tool = i === 7 || i === 8;
    await delay(delayMs);
    const toolStartedAt = performance.now();
    if (i === 7) await holdUnlessAborted(signal, HOLD_CAP_MS);
    else if (i === 8) await delay(30);
    const toolMs = tool ? performance.now() - toolStartedAt : 0;
    let spoken = "";
    const words = CANNED[i]!.split(" ");
    for (const [n, word] of words.entries()) {
      if (signal?.aborted) break;
      if (i === 5 && n === LONG_TURN_WORDS_BEFORE_STALL) {
        await holdUnlessAborted(signal, HOLD_CAP_MS);
        if (signal?.aborted) break;
      }
      onStream?.(`${word} `);
      spoken += `${word} `;
      await delay(5);
    }
    return {
      finalMessage: spoken,
      newSessionId: "s",
      errors: [],
      llmMs: 10,
      toolMs,
      toolCalls: tool ? 1 : 0,
      toolSummary: null,
      toolAckInjected: 0,
      streamed: spoken.length > 0,
      compactions: 0,
      aborted: signal?.aborted === true,
      usage: {
        inputTokens: 1,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 200000,
        costUsd: 0,
        durationMs: 10,
      },
      stageTimings: { lockWaitMs: 0, spawnPrepMs: 1, bootToInitMs: 600, initToFirstTokenMs: 900 },
    };
  };
}

describe("voice-engine-bench against the real adapter (R6)", () => {
  const rows: Record<string, unknown>[] = [];
  let stop: () => void = () => {};
  let opts: BenchOptions;
  beforeEach(async () => {
    rows.length = 0;
    const setup = makeAdapter({ spawn: scriptedSpawn(), bridgeToken: BRIDGE_TOKEN });
    const { port } = await startAdapter(setup);
    stop = () => setup.adapter.stop();
    opts = {
      baseUrl: `http://127.0.0.1:${port}`,
      token: BRIDGE_TOKEN,
      agentId: FIXTURE_AGENT_ID,
      arm: "A0-cold",
      goal: GOAL,
      context: CONTEXT,
      workerBootId: randomUUID(),
      out: (r) => rows.push(r),
      sleep: async () => {},
    };
  });
  afterEach(() => {
    stop();
    vi.clearAllMocks();
  });

  it("posts ten turns with the worker's shape, records assertions, closes twice for barge-in, never writes text or the token", async () => {
    const callId = await runBenchCall(opts, "bench-r6");
    expect(callId).toBe("bench-r6");
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.turnIndex)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(rows.filter((r) => r.finish === "closed").map((r) => r.turnIndex)).toEqual([5, 7]);
    // 5 closes mid-sentence (some text heard, not all of it); 7 closes during the tool wait (no text at all).
    const long = rows.find((r) => r.turnIndex === 5)!;
    expect(long.textLength).toBeGreaterThan(0);
    expect(long.textLength).toBeLessThan(CANNED[5]!.length);
    expect(rows.find((r) => r.turnIndex === 7)!.clientFirstTextMs).toBeNull();
    expect(rows.filter((r) => r.expectsTool).map((r) => r.turnIndex)).toEqual([7, 8]);
    expect(rows.find((r) => r.turnIndex === 2)!.keywordPass).toBe(true);
    expect(rows.find((r) => r.turnIndex === 1)!.keywordPass).toBeNull();
    const received = engineRows("engine_received").filter((r) => r.callId === "bench-r6");
    expect(received).toHaveLength(10);
    expect(received.every((r) => r.correlation === "worker")).toBe(true);
    expect(new Set(received.map((r) => r.turnId)).size).toBe(10);
    const terminals = engineRows("engine_attempt_terminal").filter((r) => r.callId === "bench-r6");
    expect(terminals.filter((r) => r.outcome === "cancelled")).toHaveLength(2);
    expect(terminals.find((r) => r.turnId === rows.find((x) => x.turnIndex === 8)!.turnId)!.toolCount).toBe(1);
    const dump = JSON.stringify(rows);
    for (const s of [
      BRIDGE_TOKEN,
      GOAL,
      CONTEXT,
      "hive_agent_id",
      ...Object.values(CANNED),
      ...BENCH_SCRIPT.map((t) => t.text),
    ]) {
      expect(dump).not.toContain(s);
    }
  });

  it("double-request: turn 2 is posted before turn 1 settles and both complete", async () => {
    await runBenchCall({ ...opts, drill: "double-request" }, "bench-dbl");
    expect(rows.filter((r) => r.drill === "double-request")).toHaveLength(2);
    expect(engineRows("engine_received").filter((r) => r.callId === "bench-dbl")).toHaveLength(10);
  });

  it("three concurrent calls keep their ids and rows apart", async () => {
    const ids = await Promise.all(["c1", "c2", "c3"].map((id) => runBenchCall(opts, `bench-${id}`)));
    for (const id of ids) {
      expect(rows.filter((r) => r.callId === id)).toHaveLength(10);
      expect(engineRows("engine_received").filter((r) => r.callId === id)).toHaveLength(10);
    }
  });

  it.each([
    ["kill-a", "before-first-byte", 3],
    ["kill-b", "after-first-byte", 3],
    ["kill-c", "before-first-byte", 1],
  ] as const)(
    "%s fires the kill hook exactly once at %s on turn %d, tags the row, and holds the call until the hook resolves",
    async (drill, phase, turnIndex) => {
      // Stands in for the operator prompt: resolves only when the test says the operator is done.
      let operatorDone!: () => void;
      const kill = vi.fn<NonNullable<BenchOptions["kill"]>>(() => new Promise<void>((r) => (operatorDone = r)));
      const callId = `bench-${drill}`;
      const call = runBenchCall({ ...opts, drill, kill }, callId);
      await vi.waitFor(() => expect(kill).toHaveBeenCalledTimes(1), { timeout: 5_000 });
      // Timing-independent: let the engine finish the drilled turn entirely (its terminal row is emitted only
      // after the response is flushed) while the hook is still pending — the Tokyo turn's short reply included.
      await vi.waitFor(
        () => expect(engineRows("engine_terminal").filter((r) => r.callId === callId)).toHaveLength(turnIndex),
        { timeout: 5_000 },
      );
      await delay(OPERATOR_HOLD_MS);
      // A fired-and-forgotten hook would have let the bench record the drilled turn and post the next one by now.
      expect(rows).toHaveLength(turnIndex - 1);
      expect(engineRows("engine_received").filter((r) => r.callId === callId)).toHaveLength(turnIndex);
      operatorDone();
      await call;
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill.mock.calls[0]![0]).toBe(phase);
      expect(kill.mock.calls[0]![1].index).toBe(turnIndex);
      expect(rows.filter((r) => r.drill === drill).map((r) => r.turnIndex)).toEqual([turnIndex]);
      expect(rows).toHaveLength(10);
      // Nothing buffered during the hold was dropped: the whole answer (ending on its keyword) was processed after it.
      const drilled = rows.find((r) => r.turnIndex === turnIndex)!;
      expect(drilled).toMatchObject({ finish: "stop", status: 200 });
      expect(drilled.textLength).toBe(`${CANNED[turnIndex]} `.length); // scriptedSpawn streams each word plus a space
      if (turnIndex === 3) expect(drilled.keywordPass).toBe(true);
      expect(drilled.clientTotalMs as number).toBeGreaterThanOrEqual(OPERATOR_HOLD_MS);
    },
  );
});

describe("postTurn awaits drill hooks against a single-write response", () => {
  // The whole answer in ONE write, then end, with a server keep-alive shorter than the hold: the case where the
  // rest of the first-text chunk is already parsed, `end` is emitted on the paused stream, and the server closes the
  // socket while the operator is still at the prompt. None of it may be processed, dropped, or settle the turn early.
  const frame = (choice: Record<string, unknown>) => `data: ${JSON.stringify({ choices: [choice] })}\n\n`;
  const BODY =
    frame({ delta: { content: "The capital " } }) +
    frame({ delta: { content: "is Tokyo." } }) +
    frame({ delta: {}, finish_reason: "stop" }) +
    "data: [DONE]\n\n";
  let server: Server;
  let serverEnded = false;
  let opts: BenchOptions;
  beforeEach(async () => {
    serverEnded = false;
    server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        res.end(BODY, () => (serverEnded = true));
      });
    });
    server.keepAliveTimeout = 20;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    opts = {
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: BRIDGE_TOKEN,
      agentId: FIXTURE_AGENT_ID,
      arm: "A1-warm",
      goal: GOAL,
      context: CONTEXT,
      workerBootId: randomUUID(),
      out: () => {},
    };
  });
  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
  });

  it.each(["onSent", "onFirstText"] as const)(
    "%s: nothing after the hold point is processed and the turn does not settle until the hook resolves",
    async (hookName) => {
      let turnSettled = false;
      const duringHold: { serverEnded?: boolean; turnSettled?: boolean } = {};
      const hook = async () => {
        await vi.waitFor(() => expect(serverEnded).toBe(true));
        await delay(OPERATOR_HOLD_MS);
        duringHold.serverEnded = serverEnded;
        duringHold.turnSettled = turnSettled;
      };
      const turn = postTurn(opts, {}, { [hookName]: hook });
      void turn.then(() => (turnSettled = true));
      const outcome = await turn;
      expect(duringHold).toEqual({ serverEnded: true, turnSettled: false });
      expect(outcome).toMatchObject({ status: 200, text: "The capital is Tokyo.", finish: "stop" });
      expect(outcome.totalMs).toBeGreaterThanOrEqual(OPERATOR_HOLD_MS);
    },
  );

  it("a hook that rejects rejects the turn instead of hanging it", async () => {
    await expect(postTurn(opts, {}, { onFirstText: () => Promise.reject(new Error("prompt failed")) })).rejects.toThrow(
      "prompt failed",
    );
  });
});

describe("voice-engine-bench argument validation", () => {
  const originalConfig = configRef.current;
  let stderr: string[];
  let stderrSpy: { mockRestore: () => void };
  let out: string;
  beforeEach(() => {
    stderr = [];
    stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(String(chunk));
      return true;
    });
    out = join(mkdtempSync(join(tmpdir(), "kpr465-bench-")), "out.jsonl");
    // A configured token, so a refusal below can only come from the validation under test.
    configRef.current = {
      ...originalConfig,
      voice: { ...originalConfig.voice, bridgeToken: "tok-validation-sentinel", port: 3200 },
    };
  });
  afterEach(() => {
    stderrSpy.mockRestore();
    configRef.current = originalConfig;
  });

  it("parseCallCount accepts only a positive decimal integer", () => {
    expect(parseCallCount("8")).toBe(8);
    expect(parseCallCount("1")).toBe(1);
    for (const bad of ["abc", "", "0", "-1", "8abc", "1e3", "1.5", " 8", "9007199254740993"]) {
      expect(parseCallCount(bad)).toBeNull();
    }
  });

  it("resolveCallsCount (KPR-465 review round 1): a kill-* drill defaults to 1 call, everything else defaults to 8, an explicit --calls always wins", () => {
    expect(resolveCallsCount(undefined, undefined)).toBe(8);
    expect(resolveCallsCount(undefined, "double-request")).toBe(8);
    expect(resolveCallsCount(undefined, "concurrent-3")).toBe(8);
    expect(resolveCallsCount(undefined, "kill-a")).toBe(1);
    expect(resolveCallsCount(undefined, "kill-b")).toBe(1);
    expect(resolveCallsCount(undefined, "kill-c")).toBe(1);
    expect(resolveCallsCount("3", "kill-a")).toBe(3); // explicit override still honored for a kill drill
    expect(resolveCallsCount("3", undefined)).toBe(3);
    expect(resolveCallsCount("abc", "kill-a")).toBeNull(); // still validated
  });

  it("loopbackBaseUrlError accepts plain http to 127.0.0.1 or localhost only", () => {
    expect(loopbackBaseUrlError("http://127.0.0.1:3200")).toBeNull();
    expect(loopbackBaseUrlError("http://localhost:3200")).toBeNull();
    for (const bad of [
      "https://127.0.0.1:3200",
      "https://localhost:3200",
      "http://example.com:3200",
      "http://10.0.0.5:3200",
      "http://127.0.0.1.example.com:3200",
      "not a url",
    ]) {
      expect(loopbackBaseUrlError(bad)).toMatch(/--base-url/);
    }
  });

  it("main exits 2 on a non-numeric --calls before writing the result file", async () => {
    expect(await main(["--arm", "A0-cold", "--out", out, "--calls", "abc"])).toBe(2);
    expect(stderr.join("")).toMatch(/--calls must be a positive integer, got "abc"/);
    expect(existsSync(out)).toBe(false);
  });

  it.each(["https://127.0.0.1:1", "http://bench.invalid:1"])(
    "main exits 2 on --base-url %s before writing the result file or sending the bearer",
    async (baseUrl) => {
      expect(await main(["--arm", "A0-cold", "--out", out, "--calls", "1", "--base-url", baseUrl])).toBe(2);
      const text = stderr.join("");
      expect(text).toMatch(/--base-url must be http:\/\/127\.0\.0\.1:<port> or http:\/\/localhost:<port>/);
      expect(text).not.toContain("tok-validation-sentinel");
      expect(existsSync(out)).toBe(false);
    },
  );
});
