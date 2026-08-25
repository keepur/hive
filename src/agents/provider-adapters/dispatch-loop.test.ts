import { describe, expect, it } from "vitest";
import {
  DEFAULT_MAX_ROUNDS,
  runBoundedDispatchLoop,
  type BoundedDispatchLoopDriver,
} from "./dispatch-loop.js";
import type { LaneBTurnHarness, LaneBTurnTotals } from "./turn-scaffold.js";
import type { ToolBridge } from "./tool-bridge.js";
import type { AgentProviderTurnRequest } from "./types.js";

// --- Fixtures ---------------------------------------------------------------

interface HarnessFixture {
  harness: LaneBTurnHarness;
  totals: LaneBTurnTotals;
  /** Flip the abort flag the loop's four checkpoints read. */
  setAborted(): void;
}

/**
 * Hand-rolled LaneBTurnHarness — the loop only touches isAborted/addUsage/
 * setLastProviderRoundId/lastProviderRoundId/fallbackSessionId/
 * interruptionSessionId, so bridge/signal/request are inert stand-ins.
 */
function makeHarness(request: AgentProviderTurnRequest = { prompt: "hello" }): HarnessFixture {
  let abortedFlag = false;
  let lastRoundId: string | undefined;
  const totals: LaneBTurnTotals = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 };
  const harness: LaneBTurnHarness = {
    request,
    bridge: {} as unknown as ToolBridge,
    signal: new AbortController().signal,
    streamed: false,
    fallbackSessionId: "fb",
    isAborted: () => abortedFlag,
    deadlineFired: () => false,
    totals,
    addUsage: (delta) => {
      totals.inputTokens += delta.inputTokens ?? 0;
      totals.outputTokens += delta.outputTokens ?? 0;
      totals.cacheReadTokens += delta.cacheReadTokens ?? 0;
    },
    setLastProviderRoundId: (id) => {
      lastRoundId = id;
    },
    lastProviderRoundId: () => lastRoundId,
    interruptionSessionId: () => "int-sid",
  };
  return {
    harness,
    totals,
    setAborted: () => {
      abortedFlag = true;
    },
  };
}

/** Scripted round state: what this round harvested plus its assistant text. */
interface Round {
  calls: string[];
}

const req = (maxTurns?: number): AgentProviderTurnRequest =>
  maxTurns === undefined
    ? { prompt: "hello" }
    : { prompt: "hello", resourceLimits: { maxTurns, timeoutMs: 60_000, budgetUsd: 0 } };

function makeDriver(
  harness: LaneBTurnHarness,
  overrides: Partial<BoundedDispatchLoopDriver<Round, string>> & {
    request: AgentProviderTurnRequest;
  },
): BoundedDispatchLoopDriver<Round, string> {
  return {
    harness,
    executeRound: async () => ({ state: { calls: [] }, usage: {}, text: "" }),
    harvest: (state) => state.calls,
    executeCall: async () => {},
    ...overrides,
  };
}

/** A round driver that always harvests one call ⇒ the loop never breaks. */
const alwaysCalls = (rounds: number[]) => async (round: number) => {
  rounds.push(round);
  return { state: { calls: ["c"] }, usage: {}, text: `r${round}` };
};

// --- Round budget -----------------------------------------------------------

describe("runBoundedDispatchLoop — round budget", () => {
  it("stops at maxTurns with error_max_turns and the interruption sessionId", async () => {
    const { harness } = makeHarness();
    const rounds: number[] = [];
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, { request: req(2), executeRound: alwaysCalls(rounds) }),
    );

    expect(outcome).toEqual({ kind: "error", error: "error_max_turns", sessionId: "int-sid" });
    expect(rounds).toEqual([1, 2]);
  });

  it("short-circuits maxTurns: 0 with NO round call (no network)", async () => {
    const { harness } = makeHarness();
    const rounds: number[] = [];
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, { request: req(0), executeRound: alwaysCalls(rounds) }),
    );

    expect(outcome).toEqual({ kind: "error", error: "error_max_turns", sessionId: "int-sid" });
    expect(rounds).toEqual([]);
  });

  it("defaults to DEFAULT_MAX_ROUNDS (10) when resourceLimits is absent", async () => {
    expect(DEFAULT_MAX_ROUNDS).toBe(10);
    const { harness } = makeHarness();
    const rounds: number[] = [];
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, { request: req(), executeRound: alwaysCalls(rounds) }),
    );

    expect(outcome).toMatchObject({ kind: "error", error: "error_max_turns" });
    expect(rounds).toHaveLength(DEFAULT_MAX_ROUNDS);
    expect(rounds[rounds.length - 1]).toBe(10);
  });
});

// --- Totals accumulation ----------------------------------------------------

describe("runBoundedDispatchLoop — totals", () => {
  it("folds each round's usage into the scaffold accumulator", async () => {
    const { harness, totals } = makeHarness();
    let round = 0;
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => {
          round += 1;
          return round === 1
            ? {
                state: { calls: ["c"] },
                usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 3 },
                text: "draft",
              }
            : {
                state: { calls: [] },
                usage: { inputTokens: 10, outputTokens: 20, cacheReadTokens: 30 },
                text: "final",
              };
        },
      }),
    );

    expect(outcome).toMatchObject({ kind: "success" });
    expect(totals).toEqual({ inputTokens: 11, outputTokens: 22, cacheReadTokens: 33 });
  });

  it("keeps accumulated totals on the error_max_turns path (outcome, not throw)", async () => {
    const { harness, totals } = makeHarness();
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(2),
        executeRound: async (round) => ({
          state: { calls: ["c"] },
          usage: { inputTokens: 5, outputTokens: 1 },
          text: `r${round}`,
        }),
      }),
    );

    expect(outcome).toMatchObject({ kind: "error", error: "error_max_turns" });
    expect(totals).toEqual({ inputTokens: 10, outputTokens: 2, cacheReadTokens: 0 });
  });
});

// --- Abort checkpoints ------------------------------------------------------

describe("runBoundedDispatchLoop — abort checkpoints", () => {
  it("interrupts at the pre-round checkpoint", async () => {
    const { harness, setAborted } = makeHarness();
    setAborted();
    const rounds: number[] = [];
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, { request: req(5), executeRound: alwaysCalls(rounds) }),
    );

    expect(outcome).toEqual({ kind: "interrupted" });
    expect(rounds).toEqual([]);
  });

  it("interrupts at the post-stream checkpoint", async () => {
    const { harness, setAborted } = makeHarness();
    const executed: string[] = [];
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => {
          setAborted(); // fired while the stream was being consumed
          return { state: { calls: ["c"] }, usage: {}, text: "partial" };
        },
        executeCall: async (call) => {
          executed.push(call);
        },
      }),
    );

    expect(outcome).toEqual({ kind: "interrupted" });
    expect(executed).toEqual([]);
  });

  it("interrupts at the pre-tool checkpoint, leaving later calls unexecuted", async () => {
    const { harness, setAborted } = makeHarness();
    const executed: string[] = [];
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => ({ state: { calls: ["a", "b"] }, usage: {}, text: "t" }),
        executeCall: async (call) => {
          executed.push(call);
          setAborted(); // deadline/operator abort mid-tool
        },
      }),
    );

    expect(outcome).toEqual({ kind: "interrupted" });
    expect(executed).toEqual(["a"]);
  });

  it("interrupts at the post-loop checkpoint", async () => {
    const { harness, setAborted } = makeHarness();
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => ({ state: { calls: [] }, usage: {}, text: "final" }),
        harvest: (state) => {
          setAborted(); // aborted after the last round harvested nothing
          return state.calls;
        },
      }),
    );

    expect(outcome).toEqual({ kind: "interrupted" });
  });
});

// --- Sequential execution ---------------------------------------------------

describe("runBoundedDispatchLoop — tool execution", () => {
  it("executes harvested calls sequentially with no interleaving", async () => {
    const { harness } = makeHarness();
    const log: string[] = [];
    let round = 0;
    await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => {
          round += 1;
          return {
            state: { calls: round === 1 ? ["a", "b", "c"] : [] },
            usage: {},
            text: "t",
          };
        },
        executeCall: async (call) => {
          log.push(`start:${call}`);
          await Promise.resolve();
          await Promise.resolve();
          log.push(`end:${call}`);
        },
      }),
    );

    expect(log).toEqual(["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  });

  it("dedups by callId when the driver supplies one", async () => {
    const { harness } = makeHarness();
    const executed: string[] = [];
    let round = 0;
    await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => {
          round += 1;
          return { state: { calls: round === 1 ? ["a", "a", "b"] : [] }, usage: {}, text: "t" };
        },
        callId: (call) => call,
        executeCall: async (call) => {
          executed.push(call);
        },
      }),
    );

    expect(executed).toEqual(["a", "b"]);
  });

  it("executes duplicates when no callId hook is supplied (harvest owns dedup)", async () => {
    const { harness } = makeHarness();
    const executed: string[] = [];
    let round = 0;
    await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => {
          round += 1;
          return { state: { calls: round === 1 ? ["a", "a", "b"] : [] }, usage: {}, text: "t" };
        },
        executeCall: async (call) => {
          executed.push(call);
        },
      }),
    );

    expect(executed).toEqual(["a", "a", "b"]);
  });

  it("propagates a beforeExecuteCalls throw out of the loop", async () => {
    const { harness } = makeHarness();
    const boom = new Error("missing interaction id");
    await expect(
      runBoundedDispatchLoop(
        makeDriver(harness, {
          request: req(5),
          executeRound: async () => ({ state: { calls: ["a"] }, usage: {}, text: "t" }),
          beforeExecuteCalls: () => {
            throw boom;
          },
        }),
      ),
    ).rejects.toBe(boom);
  });

  it("hands the executed calls to afterCalls", async () => {
    const { harness } = makeHarness();
    const seen: string[][] = [];
    let round = 0;
    await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => {
          round += 1;
          return { state: { calls: round === 1 ? ["a", "b"] : [] }, usage: {}, text: "t" };
        },
        afterCalls: (_state, calls) => {
          seen.push(calls);
        },
      }),
    );

    expect(seen).toEqual([["a", "b"]]);
  });
});

// --- Restart affordance (codex §D7) -----------------------------------------

describe("runBoundedDispatchLoop — restart affordance", () => {
  it("resets the round counter and the full budget on restart-fresh", async () => {
    const { harness } = makeHarness();
    const observed: number[] = [];
    let attempts = 0;
    let healed = false;

    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(2),
        executeRound: async (round) => {
          observed.push(round);
          attempts += 1;
          if (attempts === 1) throw new Error("poisoned replay");
          return { state: { calls: ["c"] }, usage: {}, text: `r${round}` };
        },
        onRequestError: async () => {
          if (healed) return undefined;
          healed = true;
          return { action: "restart-fresh" };
        },
      }),
    );

    // Round numbering restarts at 1 and the healed turn still gets 2 rounds.
    expect(observed).toEqual([1, 1, 2]);
    expect(outcome).toMatchObject({ kind: "error", error: "error_max_turns" });
  });

  it("propagates the original error once the heal is spent", async () => {
    const { harness } = makeHarness();
    const first = new Error("first failure");
    const second = new Error("second failure");
    let attempts = 0;
    let healed = false;

    await expect(
      runBoundedDispatchLoop(
        makeDriver(harness, {
          request: req(5),
          executeRound: async () => {
            attempts += 1;
            throw attempts === 1 ? first : second;
          },
          onRequestError: async () => {
            if (healed) return undefined;
            healed = true;
            return { action: "restart-fresh" };
          },
        }),
      ),
    ).rejects.toBe(second);
    expect(attempts).toBe(2);
  });

  it("substitutes the decorated error on rethrow", async () => {
    const { harness } = makeHarness();
    const original = new Error("raw 400");
    const decorated = new Error("decorated 400");

    await expect(
      runBoundedDispatchLoop(
        makeDriver(harness, {
          request: req(5),
          executeRound: async () => {
            throw original;
          },
          onRequestError: async () => ({ action: "rethrow", error: decorated }),
        }),
      ),
    ).rejects.toBe(decorated);
  });

  it("rethrows the original error when no onRequestError hook exists", async () => {
    const { harness } = makeHarness();
    const boom = new Error("no hook");

    await expect(
      runBoundedDispatchLoop(
        makeDriver(harness, {
          request: req(5),
          executeRound: async () => {
            throw boom;
          },
        }),
      ),
    ).rejects.toBe(boom);
  });
});

// --- Success semantics ------------------------------------------------------

describe("runBoundedDispatchLoop — success semantics", () => {
  it("returns the final round's text only", async () => {
    const { harness } = makeHarness();
    let round = 0;
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => {
          round += 1;
          return round === 1
            ? { state: { calls: ["c"] }, usage: {}, text: "draft" }
            : { state: { calls: [] }, usage: {}, text: "final" };
        },
      }),
    );

    expect(outcome).toEqual({ kind: "success", text: "final", sessionId: "fb" });
  });

  it("prefers the last provider round id as the success sessionId", async () => {
    const { harness } = makeHarness();
    let round = 0;
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => {
          round += 1;
          return round === 1
            ? { state: { calls: ["c"] }, usage: {}, providerRoundId: "resp-1", text: "draft" }
            : { state: { calls: [] }, usage: {}, providerRoundId: "resp-2", text: "final" };
        },
      }),
    );

    expect(outcome).toEqual({ kind: "success", text: "final", sessionId: "resp-2" });
  });

  it("falls back to fallbackSessionId when no round reported an id", async () => {
    const { harness } = makeHarness();
    const outcome = await runBoundedDispatchLoop(
      makeDriver(harness, {
        request: req(5),
        executeRound: async () => ({ state: { calls: [] }, usage: {}, text: "done" }),
      }),
    );

    expect(outcome).toEqual({ kind: "success", text: "done", sessionId: "fb" });
  });
});
