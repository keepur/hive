/**
 * KPR-465 R6: the engine bench driven against the REAL VoiceAdapter over
 * loopback HTTP — a local in-process adapter with a scripted fake spawn (no
 * instance, no model). Pins the worker-shaped request, the two barge-in
 * closes, the drills, and that result rows stay content-free.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";

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
    voice: { assistants: {} as Record<string, string> },
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
import { runBenchCall, type BenchOptions } from "./voice-engine-bench.js";
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
    "%s fires the kill hook exactly once at %s on turn %d and tags the row",
    async (drill, phase, turnIndex) => {
      const kill = vi.fn<NonNullable<BenchOptions["kill"]>>(async () => {});
      await runBenchCall({ ...opts, drill, kill }, `bench-${drill}`);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill.mock.calls[0]![0]).toBe(phase);
      expect(kill.mock.calls[0]![1].index).toBe(turnIndex);
      expect(rows.filter((r) => r.drill === drill).map((r) => r.turnIndex)).toEqual([turnIndex]);
    },
  );
});
