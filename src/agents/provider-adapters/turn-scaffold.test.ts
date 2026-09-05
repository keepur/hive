import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tmpdir } from "node:os";
import {
  LaneBTurnScaffold,
  type LaneBSessionPolicyState,
  type LaneBTurnHarness,
  type LaneBTurnOutcome,
} from "./turn-scaffold.js";
import { ToolBridge } from "./tool-bridge.js";
import { TURN_DEADLINE_SUBTYPE } from "./error-classification.js";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { AgentProviderTurnRequest } from "./types.js";
import { MEMORY_TURN_HEADER, memoryDigest, appendDateTimeTrailer } from "../prefix-builder.js";

// The real ToolBridge the scaffold constructs logs; keep the suite quiet.
const logMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("../../logging/logger.js", () => ({
  createLogger: () => logMock,
}));

// --- Fixtures ---------------------------------------------------------------

/** Minimal assembly literal — mirrors the three adapter suites' makeAssembly. */
function makeAssembly(overrides: Partial<ProviderTurnAssembly> = {}): ProviderTurnAssembly {
  return {
    instructions: "Be useful.",
    toolInventory: [],
    omittedTools: [],
    guardrailGate: async () => ({ behavior: "allow" }),
    memory: {},
    skillIndex: [],
    inProcessServers: {},
    sessionCwd: tmpdir(),
    ...overrides,
  };
}

type ExecuteImpl = (harness: LaneBTurnHarness) => Promise<LaneBTurnOutcome>;

/** Default-policy subclass: injectable executeTurn + a deadline-warn recorder. */
class TestScaffoldAdapter extends LaneBTurnScaffold {
  readonly provider = "codex" as const;
  readonly warnings: number[] = [];

  constructor(
    private readonly impl: ExecuteImpl,
    assembly: ProviderTurnAssembly = makeAssembly(),
    name = "test-agent",
  ) {
    super({ name, assembly });
  }

  // Deliberately NOT async: a synchronous throw from `impl` must reach the
  // scaffold's try synchronously (the pre-request-throw path).
  protected executeTurn(harness: LaneBTurnHarness): Promise<LaneBTurnOutcome> {
    return this.impl(harness);
  }

  protected warnDeadlineExpired(timeoutMs: number): void {
    this.warnings.push(timeoutMs);
  }
}

/** Codex-style policy subclass: fabricated fallback + round-id interruption. */
class CodexStyleScaffoldAdapter extends TestScaffoldAdapter {
  protected override fallbackSessionId(request: AgentProviderTurnRequest): string {
    return request.sessionId ?? "codex-pilot-fixed";
  }

  protected override interruptionSessionId(state: LaneBSessionPolicyState): string {
    return state.lastProviderRoundId ?? state.fallbackSessionId;
  }
}

const req = (overrides: Partial<AgentProviderTurnRequest> = {}): AgentProviderTurnRequest => ({
  prompt: "hello",
  ...overrides,
});

const limits = (timeoutMs: number) => ({ maxTurns: 10, timeoutMs, budgetUsd: 0 });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Resolves only when the turn's abort signal fires. */
const hangUntilAbort =
  (outcome: LaneBTurnOutcome = { kind: "interrupted" }): ExecuteImpl =>
  (harness) =>
    new Promise<LaneBTurnOutcome>((resolve) => {
      harness.signal.addEventListener("abort", () => resolve(outcome), { once: true });
    });

const ok = (text = "done", sessionId = "s-1"): ExecuteImpl =>
  async () => ({ kind: "success", text, sessionId });

let closeSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  closeSpy = vi.spyOn(ToolBridge.prototype, "close");
});

afterEach(() => {
  vi.restoreAllMocks();
});

// --- Bridge lifecycle -------------------------------------------------------

describe("LaneBTurnScaffold — bridge lifecycle", () => {
  it("closes the bridge exactly once on a success outcome", async () => {
    const adapter = new TestScaffoldAdapter(ok());
    await adapter.runTurn(req());
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the bridge exactly once on an error outcome", async () => {
    const adapter = new TestScaffoldAdapter(async () => ({
      kind: "error",
      error: "error_max_turns",
      sessionId: "s-1",
    }));
    await adapter.runTurn(req());
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the bridge exactly once when executeTurn throws", async () => {
    const adapter = new TestScaffoldAdapter(async () => {
      throw new Error("boom");
    });
    const result = await adapter.runTurn(req());
    expect(result.error).toBe("boom");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the bridge exactly once on an abort mid-executeTurn", async () => {
    const adapter = new TestScaffoldAdapter(hangUntilAbort());
    const pending = adapter.runTurn(req());
    adapter.abort();
    await pending;
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });

  it("closes the bridge exactly once on a pre-request (synchronous) throw", async () => {
    const adapter = new TestScaffoldAdapter((() => {
      throw new Error("pre-request failure");
    }) as ExecuteImpl);
    const result = await adapter.runTurn(req());
    expect(result.error).toBe("pre-request failure");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

// --- Abort containment ------------------------------------------------------

describe("LaneBTurnScaffold — abort containment", () => {
  it("abort() during a hanging turn yields aborted with no error, and wasAborted is true", async () => {
    const adapter = new TestScaffoldAdapter(hangUntilAbort());
    const pending = adapter.runTurn(req({ sessionId: "s-1" }));
    adapter.abort();
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBeUndefined();
    expect(result.text).toBe("");
    expect(adapter.wasAborted).toBe(true);
  });

  it("re-entry resets the aborted flag for the next turn", async () => {
    let impl: ExecuteImpl = hangUntilAbort();
    const adapter = new TestScaffoldAdapter((h) => impl(h));

    const pending = adapter.runTurn(req());
    adapter.abort();
    await pending;
    expect(adapter.wasAborted).toBe(true);

    impl = ok("second");
    const second = await adapter.runTurn(req());
    expect(second.text).toBe("second");
    expect(second.aborted).toBe(false);
    expect(adapter.wasAborted).toBe(false);
  });

  it("a thrown AbortError is contained as an interruption, not an error result", async () => {
    const adapter = new TestScaffoldAdapter(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    });
    const result = await adapter.runTurn(req({ sessionId: "s-1" }));
    expect(result.aborted).toBe(true);
    expect(result.error).toBeUndefined();
  });
});

// --- Outcome mapping --------------------------------------------------------

describe("LaneBTurnScaffold — outcome mapping", () => {
  it("maps an error outcome to a RunResult carrying accumulated totals", async () => {
    const adapter = new TestScaffoldAdapter(async (harness) => {
      harness.addUsage({ inputTokens: 10, outputTokens: 4, cacheReadTokens: 2 });
      return { kind: "error", error: "error_max_turns", sessionId: "s" };
    });

    const result = await adapter.runTurn(req());
    expect(result).toMatchObject({
      error: "error_max_turns",
      sessionId: "s",
      aborted: false,
      text: "",
      inputTokens: 10,
      outputTokens: 4,
      cacheReadTokens: 2,
    });
    expect(result.timedOut).toBeUndefined();
  });

  it("maps a success outcome to text + sessionId with aborted false and no error", async () => {
    const adapter = new TestScaffoldAdapter(ok("all good", "sess-7"));
    const result = await adapter.runTurn(req());
    expect(result).toMatchObject({ text: "all good", sessionId: "sess-7", aborted: false });
    expect(result.error).toBeUndefined();
  });
});

// --- buildResult math -------------------------------------------------------

describe("LaneBTurnScaffold — buildResult", () => {
  it("clamps llmMs at 0 when tool time exceeds wall time, and joins toolSummary", async () => {
    vi.spyOn(ToolBridge.prototype, "stats", "get").mockReturnValue({
      toolCalls: 3,
      toolMs: 5_000_000,
      perTool: new Map([
        ["Read", 2],
        ["Bash", 1],
      ]),
    });

    const adapter = new TestScaffoldAdapter(ok());
    const result = await adapter.runTurn(req());

    expect(result.llmMs).toBe(0);
    expect(result.toolMs).toBe(5_000_000);
    expect(result.toolCalls).toBe(3);
    expect(result.toolSummary).toBe("Read×2, Bash×1");
  });

  it("computes llmMs as durationMs − toolMs when tool time is smaller", async () => {
    vi.spyOn(ToolBridge.prototype, "stats", "get").mockReturnValue({
      toolCalls: 1,
      toolMs: 5,
      perTool: new Map([["Read", 1]]),
    });

    const adapter = new TestScaffoldAdapter(async () => {
      await sleep(30);
      return { kind: "success", text: "x", sessionId: "s" };
    });
    const result = await adapter.runTurn(req());

    expect(result.llmMs).toBe(Math.max(0, result.durationMs - 5));
    expect(result.llmMs).toBeGreaterThan(0);
  });

  it("reports toolSummary 'none' and zero-filled Claude-only fields with no tool calls", async () => {
    const adapter = new TestScaffoldAdapter(ok());
    const result = await adapter.runTurn(req());

    expect(result.toolSummary).toBe("none");
    expect(result.toolCalls).toBe(0);
    expect(result.toolMs).toBe(0);
    expect(result.costUsd).toBe(0);
    expect(result.cacheCreationTokens).toBe(0);
    expect(result.contextWindow).toBe(0);
    expect(result.compactions).toBe(0);
  });

  it("carries the streamed flag from the presence of onStream", async () => {
    const adapter = new TestScaffoldAdapter(ok());
    expect((await adapter.runTurn(req())).streamed).toBe(false);
    expect((await adapter.runTurn(req({ onStream: () => {} }))).streamed).toBe(true);
  });
});

// --- Session-policy hooks ---------------------------------------------------

describe("LaneBTurnScaffold — session policy hooks", () => {
  it("default fallbackSessionId is request.sessionId ?? '' on the catch-error path", async () => {
    const throwing: ExecuteImpl = async () => {
      throw new Error("kaput");
    };

    const bare = new TestScaffoldAdapter(throwing);
    expect((await bare.runTurn(req())).sessionId).toBe("");

    const resumed = new TestScaffoldAdapter(throwing);
    expect((await resumed.runTurn(req({ sessionId: "s-42" }))).sessionId).toBe("s-42");
  });

  it("a codex-style subclass fabricates a non-empty fallback on catch-error", async () => {
    const adapter = new CodexStyleScaffoldAdapter(async () => {
      throw new Error("kaput");
    });
    const result = await adapter.runTurn(req());
    expect(result.sessionId).toBe("codex-pilot-fixed");
  });

  it("a codex-style subclass uses lastProviderRoundId for the interruption result", async () => {
    const adapter = new CodexStyleScaffoldAdapter((harness) => {
      harness.setLastProviderRoundId("r-1");
      expect(harness.lastProviderRoundId()).toBe("r-1");
      return hangUntilAbort()(harness);
    });

    const pending = adapter.runTurn(req());
    adapter.abort();
    const result = await pending;

    expect(result.aborted).toBe(true);
    expect(result.sessionId).toBe("r-1");
  });

  it("the default interruption policy ignores lastProviderRoundId", async () => {
    const adapter = new TestScaffoldAdapter((harness) => {
      harness.setLastProviderRoundId("r-1");
      return hangUntilAbort()(harness);
    });

    const pending = adapter.runTurn(req({ sessionId: "s-9" }));
    adapter.abort();
    const result = await pending;

    expect(result.sessionId).toBe("s-9");
  });
});

// --- One-writer totals ------------------------------------------------------

describe("LaneBTurnScaffold — one-writer turn accumulator", () => {
  it("folds successive addUsage deltas into the result and exposes them on harness.totals", async () => {
    let observed: { inputTokens: number; outputTokens: number; cacheReadTokens: number } | undefined;

    const adapter = new TestScaffoldAdapter(async (harness) => {
      harness.addUsage({ inputTokens: 100, outputTokens: 20, cacheReadTokens: 5 });
      harness.addUsage({ inputTokens: 50, outputTokens: 7 });
      observed = { ...harness.totals };
      return { kind: "success", text: "x", sessionId: "s" };
    });

    const result = await adapter.runTurn(req());

    expect(observed).toEqual({ inputTokens: 150, outputTokens: 27, cacheReadTokens: 5 });
    expect(result).toMatchObject({ inputTokens: 150, outputTokens: 27, cacheReadTokens: 5 });
  });
});

// --- #407 wall-clock deadline ----------------------------------------------

describe("LaneBTurnScaffold — wall-clock deadline (#407)", () => {
  it("arms the deadline inside the try: a synchronous throw leaks no timer", async () => {
    const adapter = new TestScaffoldAdapter((() => {
      throw new Error("pre-request failure");
    }) as ExecuteImpl);

    const result = await adapter.runTurn(req({ resourceLimits: limits(25) }));
    expect(result.error).toBe("pre-request failure");

    // A leaked timer would warn (and abort) past the deadline.
    await sleep(80);
    expect(adapter.warnings).toEqual([]);
  });

  it("clears the timer on the success path — no late warn", async () => {
    const adapter = new TestScaffoldAdapter(ok());
    await adapter.runTurn(req({ resourceLimits: limits(25) }));
    await sleep(80);
    expect(adapter.warnings).toEqual([]);
  });

  it("clears the timer on the error-outcome path — no late warn", async () => {
    const adapter = new TestScaffoldAdapter(async () => ({
      kind: "error",
      error: "error_max_turns",
      sessionId: "s",
    }));
    await adapter.runTurn(req({ resourceLimits: limits(25) }));
    await sleep(80);
    expect(adapter.warnings).toEqual([]);
  });

  it("clears the timer on the abort path — no late warn", async () => {
    const adapter = new TestScaffoldAdapter(hangUntilAbort());
    const pending = adapter.runTurn(req({ resourceLimits: limits(200) }));
    adapter.abort();
    await pending;
    await sleep(260);
    expect(adapter.warnings).toEqual([]);
  });

  it("timeoutMs 0 fires and resolves to error_turn_deadline (timedOut, NOT aborted)", async () => {
    const adapter = new TestScaffoldAdapter(hangUntilAbort());
    const result = await adapter.runTurn(req({ sessionId: "s-1", resourceLimits: limits(0) }));

    expect(result.error).toBe(TURN_DEADLINE_SUBTYPE);
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(adapter.warnings).toEqual([0]);
  });

  it("no timeoutMs arms no deadline — a slow turn completes normally", async () => {
    const adapter = new TestScaffoldAdapter(async () => {
      await sleep(40);
      return { kind: "success", text: "slow but fine", sessionId: "s-1" };
    });

    const result = await adapter.runTurn(req());
    expect(result.text).toBe("slow but fine");
    expect(result.aborted).toBe(false);
    expect(result.error).toBeUndefined();
    expect(adapter.warnings).toEqual([]);
  });

  it("an operator abort() outranks a deadline that also fired", async () => {
    // Signal-deaf impl: the deadline genuinely fires mid-turn after abort().
    const adapter = new TestScaffoldAdapter(async () => {
      await sleep(80);
      return { kind: "interrupted" };
    });

    const pending = adapter.runTurn(req({ sessionId: "s-1", resourceLimits: limits(10) }));
    adapter.abort();
    const result = await pending;

    expect(adapter.warnings).toEqual([10]); // the deadline DID fire
    expect(result.aborted).toBe(true);
    expect(result.error).toBeUndefined();
    expect(result.timedOut).toBeUndefined();
  });

  it("the deadline result uses the bare fallback sessionId, never a mid-turn round id", async () => {
    const adapter = new CodexStyleScaffoldAdapter((harness) => {
      harness.setLastProviderRoundId("r-9");
      return hangUntilAbort()(harness);
    });

    const result = await adapter.runTurn(req({ resourceLimits: limits(15) }));

    expect(result.error).toBe(TURN_DEADLINE_SUBTYPE);
    expect(result.timedOut).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.sessionId).toBe("codex-pilot-fixed");
    expect(adapter.warnings).toEqual([15]);
  });

  it("exposes deadlineFired() to provider code once the deadline has fired", async () => {
    let firedDuringTurn: boolean | undefined;

    const adapter = new TestScaffoldAdapter(async (harness) => {
      expect(harness.deadlineFired()).toBe(false);
      await sleep(40);
      firedDuringTurn = harness.deadlineFired();
      expect(harness.isAborted()).toBe(true);
      return { kind: "interrupted" };
    });

    await adapter.runTurn(req({ resourceLimits: limits(10) }));
    expect(firedDuringTurn).toBe(true);
  });
});

describe("KPR-432: datetime trailer on the turn input", () => {
  afterEach(() => vi.useRealTimers());

  it("primary assembly (datetimeInTurnInput: true) → harness.request.prompt ends with the trailer", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-04T17:17:01Z")); // 10:17 AM PDT
    let seen: string | undefined;
    const adapter = new TestScaffoldAdapter(
      async (harness) => {
        seen = harness.request.prompt;
        return { kind: "success", text: "ok", sessionId: "s-1" };
      },
      makeAssembly({ datetimeInTurnInput: true }),
    );
    await adapter.runTurn(req({ prompt: "hello" }));
    expect(seen).toBe("hello\n\n**Current date/time**: Friday, September 4, 2026 at 10:17 AM (Pacific Time)");
  });

  it("nested assembly (false) and flag-less assembly → prompt byte-identical", async () => {
    for (const assembly of [makeAssembly({ datetimeInTurnInput: false }), makeAssembly()]) {
      let seen: string | undefined;
      const adapter = new TestScaffoldAdapter(async (harness) => {
        seen = harness.request.prompt;
        return { kind: "success", text: "ok", sessionId: "s-1" };
      }, assembly);
      await adapter.runTurn(req({ prompt: "hello" }));
      expect(seen).toBe("hello");
    }
  });

  it("the rewrite precedes ToolBridge construction: a pre-request throw still closes the bridge (unchanged)", async () => {
    const adapter = new TestScaffoldAdapter(
      () => {
        throw new Error("pre-request");
      },
      makeAssembly({ datetimeInTurnInput: true }),
    );
    const result = await adapter.runTurn(req());
    expect(result.error).toBe("pre-request");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});

describe("KPR-434: memory block on the turn input (server-resumable assemblies)", () => {
  const NOW = new Date("2026-09-05T17:17:01Z"); // 10:17 AM PDT
  const BLOCK = "## Your Memory\n\n### Key Facts\n- [2026-09-05] scaffold fact (high)";
  const memAssembly = (overrides: Partial<ProviderTurnAssembly> = {}) =>
    makeAssembly({
      datetimeInTurnInput: true,
      memoryInTurnInput: true,
      memory: { hotTierPrompt: BLOCK, block: BLOCK, digest: memoryDigest(BLOCK) },
      ...overrides,
    });
  const capture = (assembly: ProviderTurnAssembly) => {
    let seen: string | undefined;
    const adapter = new TestScaffoldAdapter(async (harness) => {
      seen = harness.request.prompt;
      return { kind: "success", text: "ok", sessionId: "s-1" };
    }, assembly);
    return { adapter, seen: () => seen };
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => vi.useRealTimers());

  it("fresh request ⇒ header + block + prompt + datetime, and RunResult.memoryDigestInjected", async () => {
    const { adapter, seen } = capture(memAssembly());
    const result = await adapter.runTurn(req({ prompt: "hello" }));
    expect(seen()).toBe(`${MEMORY_TURN_HEADER}\n\n${BLOCK}\n\nhello\n\n**Current date/time**: Saturday, September 5, 2026 at 10:17 AM (Pacific Time)`);
    expect(result.memoryDigestInjected).toBe(memoryDigest(BLOCK));
  });

  it("resumed with an equal mark ⇒ datetime only; a differing mark ⇒ block again", async () => {
    const equal = capture(memAssembly());
    const r1 = await equal.adapter.runTurn(req({ prompt: "hello", sessionId: "s-1", memoryDigestSeen: memoryDigest(BLOCK) }));
    expect(equal.seen()).toBe(appendDateTimeTrailer("hello", NOW));
    expect(r1).not.toHaveProperty("memoryDigestInjected");

    const differing = capture(memAssembly());
    const r2 = await differing.adapter.runTurn(req({ prompt: "hello", sessionId: "s-1", memoryDigestSeen: "0000000000000000" }));
    expect(differing.seen()!.startsWith(MEMORY_TURN_HEADER)).toBe(true);
    expect(r2.memoryDigestInjected).toBe(memoryDigest(BLOCK));
  });

  it("systemPromptOverride ⇒ never injects (voice/worker shape), datetime still rides", async () => {
    const { adapter, seen } = capture(memAssembly());
    const result = await adapter.runTurn(req({ prompt: "hello", systemPromptOverride: "OVERRIDE" }));
    expect(seen()).toBe(appendDateTimeTrailer("hello", NOW));
    expect(result).not.toHaveProperty("memoryDigestInjected");
  });

  it("stateless assembly (memoryInTurnInput false, block still present) ⇒ datetime only; nested (both flags false) ⇒ byte-identical", async () => {
    const stateless = capture(memAssembly({ memoryInTurnInput: false }));
    await stateless.adapter.runTurn(req({ prompt: "hello" }));
    expect(stateless.seen()).toBe(appendDateTimeTrailer("hello", NOW));

    const nested = capture(memAssembly({ datetimeInTurnInput: false, memoryInTurnInput: false }));
    await nested.adapter.runTurn(req({ prompt: "hello" }));
    expect(nested.seen()).toBe("hello");
  });

  it("operand-order pin (D5): an assembly with memoryInTurnInput absent AND memory undefined (JS-plugin shape) passes through without throwing", async () => {
    const jsPlugin = { ...makeAssembly({ datetimeInTurnInput: true }), memory: undefined } as unknown as ProviderTurnAssembly;
    const { adapter, seen } = capture(jsPlugin);
    const result = await adapter.runTurn(req({ prompt: "hello" }));
    expect(result.error).toBeUndefined();
    expect(seen()).toBe(appendDateTimeTrailer("hello", NOW));
    // And with the flag SET but no bundle: `?.` keeps it a no-inject, never a throw.
    const flagged = capture({ ...jsPlugin, memoryInTurnInput: true } as ProviderTurnAssembly);
    const r2 = await flagged.adapter.runTurn(req({ prompt: "hello" }));
    expect(r2.error).toBeUndefined();
    expect(flagged.seen()).toBe(appendDateTimeTrailer("hello", NOW));
  });

  it("the compose still precedes ToolBridge construction: a pre-request throw still closes the bridge exactly once", async () => {
    const adapter = new TestScaffoldAdapter(
      () => {
        throw new Error("pre-request");
      },
      memAssembly(),
    );
    const result = await adapter.runTurn(req());
    expect(result.error).toBe("pre-request");
    expect(closeSpy).toHaveBeenCalledTimes(1);
  });
});
