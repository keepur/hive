import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Quiets the four modules that log on these paths (observe.ts's containment
// warn, the publisher's fault warns, agent-runner's archetype error). Returns
// ONE object so a case could count lines; no case asserts on logs today.
// vi.hoisted is required — vi.mock factories are hoisted above top-level consts.
const mockLog = vi.hoisted(() => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("../logging/logger.js", () => ({ createLogger: () => mockLog }));

import { registerArchetype, __resetRegistryForTests } from "../archetypes/registry.js";
import { __resetToolHookPayloadWarnForTests } from "../agents/agent-runner.js";
import { setOpsPublisher } from "./publisher-singleton.js";
import type { OpsPublisher } from "./publisher.js";
import { OPS_EVENTS_COLLECTION } from "./types.js";
import { REASON_TOOL_FAILED, REASON_TOOL_RECOVERED } from "./reasons.js";
import {
  ARCHETYPE_DENY_ALL_ANCHOR,
  buildClaudeLaneHarness,
  buildLaneBHarness,
  buildOpsFixture,
  type OpsFixture,
} from "./testing/lane-harness.js";

/**
 * KPR-454 chunk 4, Task 5, Step 5 — the capture points, driven.
 *
 * Scope note (deliberate, disclosed in the implementation report): the
 * containment cases below assert at the CAPTURE-POINT boundary — the Claude
 * lane's hook result and Lane B's `wrap()` return text — rather than by
 * driving a full `AgentRunner.send()` and diffing `RunResult`s. That is the
 * boundary the negative-verify can actually see (an unwrapped throw in
 * `observeToolFailure` rejects out of `wrap()`'s catch, breaching the method's
 * structural no-throw promise, and rejects out of the hook callback on the
 * Claude lane), and it matches the plan's own description of chunk 5's AC8 as
 * driving "a real AgentRunner hook set and a real ToolBridge through the same
 * construction this task builds".
 *
 * ⚠ RUNNING THIS FILE NEEDS THE REPO'S STANDARD ENV STUBS. The lane harness
 * imports `agent-runner.ts`, which imports `config.ts`, which throws
 * `Missing required env var: SLACK_APP_TOKEN` at module load. Prefix the
 * vitest command with `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test
 * SLACK_SIGNING_SECRET=test` (npm run check / CI already export them); the
 * bare command in the plan's Commands section does not, and fails on import
 * rather than on an assertion. The same applies to chunk 5's acceptance file,
 * which imports the same harness.
 */

const FAILURE_INPUT = {
  hook_event_name: "PostToolUseFailure",
  tool_name: "mcp__memory__memory_save",
  tool_input: {},
  tool_use_id: "tu-1",
  error: "boom",
  duration_ms: 12,
  session_id: "s-1",
  transcript_path: "/dev/null",
  cwd: "/tmp",
};
const SUCCESS_INPUT = {
  hook_event_name: "PostToolUse",
  tool_name: "mcp__memory__memory_save",
  tool_input: {},
  tool_response: { secret: "never read" },
  tool_use_id: "tu-2",
  duration_ms: 12,
  session_id: "s-1",
  transcript_path: "/dev/null",
  cwd: "/tmp",
};

let fixture: OpsFixture;

beforeEach(async () => {
  vi.clearAllMocks();
  __resetRegistryForTests();
  fixture = await buildOpsFixture();
});

afterEach(async () => {
  await fixture.dispose();
  __resetRegistryForTests();
});

const failures = () => fixture.events().filter((e) => e.reasonId === REASON_TOOL_FAILED);
const recoveries = () => fixture.events().filter((e) => e.reasonId === REASON_TOOL_RECOVERED);

function registerThrowingArchetype(): void {
  registerArchetype({
    id: "kpr454-hook-throws",
    validateConfig: (c) => c,
    systemPromptCard: () => "",
    preToolUseHooks: () => {
      throw new Error("hook init boom");
    },
    memoryScopes: () => [],
    sessionOptions: () => ({}),
  });
}

// ───────────────────────────────────────────────────────────────────────────
// AC13 — hook placement, both directions
// ───────────────────────────────────────────────────────────────────────────

describe("AC13 — the two observers and the archetype gate cannot disarm each other", () => {
  it("direction 1: a THROWN archetype installs deny-all AND leaves both observers registered", () => {
    registerThrowingArchetype();
    const harness = buildClaudeLaneHarness({
      config: { archetype: "kpr454-hook-throws", archetypeConfig: {} },
    });

    // The pre-existing fail-closed claim (agent-runner.test.ts's own case),
    // re-asserted here so a regression shows up on THIS file too.
    expect(harness.hooks.PreToolUse).toBeDefined();
    expect(harness.hooks.PreToolUse).toHaveLength(1);
    expect(harness.hooks.PreToolUse![0]!.matcher).toBeUndefined(); // no matcher = all tools
    // The new half: the diagnostics feed survived the archetype fault.
    expect(harness.hooks.PostToolUseFailure).toHaveLength(1);
    expect(harness.hooks.PostToolUse).toHaveLength(1);
    expect(harness.hooks.PreCompact).toBeDefined(); // untouched by this ticket
  });

  it("direction 2: both assignments sit AFTER the archetype catch, at buildHooks' own indentation", () => {
    // Asserted STRUCTURALLY because it has no realizable runtime failure mode:
    // registration is straight-line assignment of two array literals and
    // cannot throw, and the only way to MAKE it throw — a vi.mock factory for
    // ../ops/observe.js that throws — kills the module import and takes
    // AgentRunner with it, leaving nothing to assert about the hook map.
    const source = readFileSync(fileURLToPath(new URL("../agents/agent-runner.ts", import.meta.url)), "utf8");
    const anchor = source.indexOf(ARCHETYPE_DENY_ALL_ANCHOR);
    expect(anchor).toBeGreaterThan(-1);
    // The anchor is the deny-all arm's permissionDecisionReason literal, which
    // occurs ONLY inside the archetype catch — pinned, because the whole
    // ordering claim rests on it being unique.
    expect(source.split(ARCHETYPE_DENY_ALL_ANCHOR)).toHaveLength(2);

    const failureAt = source.indexOf("hooks.PostToolUseFailure =");
    const successAt = source.indexOf("hooks.PostToolUse =");
    expect(failureAt).toBeGreaterThan(anchor);
    expect(successAt).toBeGreaterThan(anchor);

    // Textually-after is necessary but not sufficient — "inside the try but
    // later" would also satisfy it. The indentation is what distinguishes the
    // two: both are top-level statements of buildHooks (four spaces), where a
    // statement inside the try/catch is indented at least six.
    expect(source).toMatch(/^ {4}hooks\.PostToolUseFailure = \[\{$/m);
    expect(source).toMatch(/^ {4}hooks\.PostToolUse = \[\{$/m);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C15 — the hooks cannot alter a turn's outcome
// ───────────────────────────────────────────────────────────────────────────

describe("C15 — both matchers return an empty object", () => {
  it("resolves to {} with no hookSpecificOutput, on both events", async () => {
    const harness = buildClaudeLaneHarness();
    await expect(harness.fireFailure(FAILURE_INPUT)).resolves.toEqual({});
    await expect(harness.fireSuccess(SUCCESS_INPUT)).resolves.toEqual({});
    await fixture.drain();
    expect(failures()).toHaveLength(1); // the drive really went through the producer
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC12 — own-abort suppresses, a foreign interrupt does not, a deny publishes nothing
// ───────────────────────────────────────────────────────────────────────────

describe("AC12 — suppression", () => {
  it("Claude lane: an ABORTED runner publishes nothing", async () => {
    const harness = buildClaudeLaneHarness();
    harness.markAborted();
    expect(harness.runner.wasAborted).toBe(true);
    await expect(harness.fireFailure(FAILURE_INPUT)).resolves.toEqual({});
    await expect(harness.fireSuccess(SUCCESS_INPUT)).resolves.toEqual({});
    await fixture.drain();
    expect(fixture.events()).toHaveLength(0);
  });

  it("Lane B: an ABORTED signal publishes nothing, and the failure text is unchanged", async () => {
    const abortController = new AbortController();
    const harness = buildLaneBHarness({
      abortController,
      tools: {
        boom: async () => {
          throw new Error("kaboom");
        },
      },
    });
    abortController.abort();
    // NOTE the ordering: wrap()'s PRE-execution abort guard returns its own
    // text before t0, so to reach the CATCH with an aborted signal the abort
    // must land mid-execution. Driven below; this case covers the pre-guard.
    await expect(harness.call("boom")).resolves.toBe("Tool execution aborted (boom).");
    await fixture.drain();
    expect(fixture.events()).toHaveLength(0);
  });

  it("Lane B: an abort landing DURING execution reaches the catch and still publishes nothing", async () => {
    const abortController = new AbortController();
    const harness = buildLaneBHarness({
      abortController,
      tools: {
        boom: async () => {
          abortController.abort(); // the deadline/operator kill, mid-flight
          throw new Error("kaboom");
        },
      },
    });
    await expect(harness.call("boom")).resolves.toBe("Tool execution failed (boom): kaboom");
    await fixture.drain();
    expect(fixture.events()).toHaveLength(0);
  });

  it("Claude lane: a FOREIGN interrupt (runner not aborted) publishes errorSig interrupted", async () => {
    const harness = buildClaudeLaneHarness();
    await harness.fireFailure({
      ...FAILURE_INPUT,
      is_interrupt: true,
      error: "The tool call was interrupted before a result was received",
    });
    await fixture.drain();
    expect(failures()).toHaveLength(1);
    expect(failures()[0]!.detail.errorSig).toBe("interrupted");
  });

  it("Lane B: a guardrail DENY publishes nothing and returns the denial text", async () => {
    const harness = buildLaneBHarness({
      bridge: { gate: async () => ({ behavior: "deny", reason: "archetype says no" }) },
      tools: { boom: async () => "unreached" },
    });
    await expect(harness.call("boom")).resolves.toBe("Tool call denied by policy: archetype says no");
    await fixture.drain();
    expect(fixture.events()).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC11 — one tool, one subject.id, both lanes
// ───────────────────────────────────────────────────────────────────────────

describe("AC11 — lane parity on subject.id", () => {
  // > 64 chars of otherwise-safe characters, so applyNameAndCapEdges MUST
  // truncate-with-hash for provider constraints while wrap()'s closure keeps
  // the canonical name.
  const LONG = "mcp__a_very_long_in_process_server_name__a_tool_whose_name_is_also_long";

  it.each([
    ["short", "mcp__memory__memory_save"],
    ["truncated", LONG],
  ])("%s name: both lanes publish the CANONICAL name as subject.id", async (_label, tool) => {
    const harness = buildLaneBHarness({
      tools: {
        [tool]: async () => {
          throw new Error("kaboom");
        },
      },
    });
    await harness.call(tool);
    const claude = buildClaudeLaneHarness();
    await claude.fireFailure({ ...FAILURE_INPUT, tool_name: tool });
    await fixture.drain();

    const rows = failures();
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((r) => r.subject.id))).toEqual(new Set([tool]));
    expect(new Set(rows.map((r) => r.subject.kind))).toEqual(new Set(["tool"]));
    // The two rows differ ONLY in which capture point saw it.
    expect(rows.map((r) => r.detail.lane).sort()).toEqual(["claude", "laneB"]);
  });

  it("the truncated name really is rewritten by applyNameAndCapEdges — so the parity claim is not vacuous", () => {
    expect(LONG.length).toBeGreaterThan(64);
    const harness = buildLaneBHarness({ tools: { [LONG]: async () => "ok" } });
    const [mapped] = harness.names();
    expect(mapped).not.toBe(LONG);
    expect(mapped!.length).toBeLessThanOrEqual(64);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D6 — the slug, and its absence
// ───────────────────────────────────────────────────────────────────────────

describe("D6 — agentId is the definitions slug, and is OMITTED when absent", () => {
  it("Claude lane publishes the slug, never the display name", async () => {
    const harness = buildClaudeLaneHarness({ config: { id: "harness-agent", name: "HarnessDisplayName" } });
    await harness.fireFailure(FAILURE_INPUT);
    await fixture.drain();
    expect(failures()[0]!.detail.agentId).toBe("harness-agent");
  });

  it("Lane B publishes agentSlug when the assembly carried one", async () => {
    const harness = buildLaneBHarness({
      bridge: { agentSlug: "harness-agent" },
      tools: {
        boom: async () => {
          throw new Error("kaboom");
        },
      },
    });
    await harness.call("boom");
    await fixture.drain();
    expect(failures()[0]!.detail.agentId).toBe("harness-agent");
  });

  it("Lane B with NO agentId on the assembly omits the key entirely — no undefined, no display name", async () => {
    const harness = buildLaneBHarness({
      bridge: { agentId: "HarnessDisplayName" }, // display label present, slug absent
      tools: {
        boom: async () => {
          throw new Error("kaboom");
        },
      },
    });
    await harness.call("boom");
    await fixture.drain();
    const detail = failures()[0]!.detail;
    expect("agentId" in detail).toBe(false);
    expect(Object.values(detail)).not.toContain("HarnessDisplayName");
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D3 — the recovery half fires from the success sites
// ───────────────────────────────────────────────────────────────────────────

describe("D3 — recovery", () => {
  it("Lane B: a success AFTER a failure of the same tool publishes the clearing event", async () => {
    let fail = true;
    const harness = buildLaneBHarness({
      tools: {
        flaky: async () => {
          if (fail) throw new Error("kaboom");
          return "ok";
        },
      },
    });
    await harness.call("flaky");
    await fixture.drain();
    expect(failures()).toHaveLength(1);

    fail = false;
    await expect(harness.call("flaky")).resolves.toBe("ok");
    await fixture.drain();
    expect(recoveries()).toHaveLength(1);
    expect(recoveries()[0]!.clears).toBe(failures()[0]!.dedupeKey);
  });

  // Found by KPR-454's retroactive Frontier hard-gate review (KPR-451 register,
  // merge c068ee33): BuiltinExecutor and the delegate Task runner are
  // contractually never-throw — a Bash non-zero exit, a missing Read/Edit
  // target, or a failed delegate Task all RESOLVE as result text rather than
  // rejecting. Before the fix, the success site called `observeToolSuccess`
  // unconditionally and stored a FALSE `tool-recovered` fact for exactly this
  // shape. Mutation proof: reverting the `EXECUTOR_BACKED_BUILTIN_NAMES`/`Task`
  // guard in tool-bridge.ts's success branch turns this red (recoveries() would
  // have length 1).
  it.each(["Bash", "Task"])(
    "Lane B: %s resolving with failure-shaped TEXT (never throwing) publishes no recovery",
    async (name) => {
      let fail = true;
      const failureText = `Tool execution failed (${name}): nonzero exit`;
      const harness = buildLaneBHarness({
        tools: {
          [name]: async () => {
            if (fail) throw new Error("boom"); // opens the condition once, as any real first failure would
            return failureText; // the never-throw contract: a LOGICAL failure resolves, it does not reject
          },
        },
      });
      await harness.call(name);
      await fixture.drain();
      expect(failures()).toHaveLength(1);

      fail = false;
      await expect(harness.call(name)).resolves.toBe(failureText);
      await fixture.drain();
      expect(recoveries()).toHaveLength(0);
      expect(failures()).toHaveLength(1); // unchanged — no second failure either, honestly no signal
    },
  );

  it("Lane B: an MCP-discovered tool (not executor-backed) is unaffected — real success still recovers", async () => {
    let fail = true;
    const harness = buildLaneBHarness({
      tools: {
        mcp__server__flaky: async () => {
          if (fail) throw new Error("kaboom");
          return "ok";
        },
      },
    });
    await harness.call("mcp__server__flaky");
    await fixture.drain();
    expect(failures()).toHaveLength(1);

    fail = false;
    await expect(harness.call("mcp__server__flaky")).resolves.toBe("ok");
    await fixture.drain();
    expect(recoveries()).toHaveLength(1);
  });

  it("Claude lane: a success with NO open condition publishes nothing", async () => {
    const harness = buildClaudeLaneHarness();
    await harness.fireSuccess(SUCCESS_INPUT);
    await fixture.drain();
    expect(fixture.events()).toHaveLength(0);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The SDK-shape guard. `error-tokens.ts` is hardened for SDK drift above the
// lockfile (`^0.3.258`); the hook BODIES read `tool_name` / `error` in
// `observeToolFailure`'s ARGUMENT LIST, i.e. outside its containment, so they
// needed the same treatment. Two distinct harms: a non-object payload throws
// out of the callback INTO THE SDK (the one uncontained throw in the diff), and
// an absent `tool_name` degrades to a publishFault plus ONE WARN PER TOOL CALL
// — a flood in exactly the drift scenario the classifier was hardened against.
// ───────────────────────────────────────────────────────────────────────────

describe("the hook payload's own fields are read behind a shape guard", () => {
  const DRIFT_WARN = "carried no usable tool_name";
  const warnsMatching = (fragment: string) =>
    mockLog.warn.mock.calls.filter((call) => String(call[0]).includes(fragment)).length;
  /** The `event` each drift line named, in order — the per-event latch's surface. */
  const driftEvents = () =>
    mockLog.warn.mock.calls
      .filter((call) => String(call[0]).includes(DRIFT_WARN))
      .map((call) => (call[1] as { event: string }).event);

  beforeEach(() => {
    // The drift warn is latched per PROCESS (the condition is a property of the
    // resolved CLI, so a line per call is the flood), so each case needs it
    // re-armed to see its own first line.
    __resetToolHookPayloadWarnForTests();
  });

  it.each([
    ["undefined", undefined],
    ["null", null],
    ["a primitive", 7],
    ["a string", "PostToolUseFailure"],
  ])("%s payload: both hooks resolve to {} rather than throwing into the SDK", async (_label, payload) => {
    const harness = buildClaudeLaneHarness();
    await expect(harness.fireFailure(payload as never)).resolves.toEqual({});
    await expect(harness.fireSuccess(payload as never)).resolves.toEqual({});
    await fixture.drain();
    expect(fixture.events()).toHaveLength(0);
    expect(fixture.publisher.getSnapshot().publishFaults).toBe(0);
  });

  it("an absent tool_name: nothing published, NO publishFault, and no per-call log line", async () => {
    const harness = buildClaudeLaneHarness();
    const { tool_name: _dropped, ...noName } = FAILURE_INPUT;
    for (let i = 0; i < 4; i += 1) await expect(harness.fireFailure(noName)).resolves.toEqual({});
    await fixture.drain();

    expect(fixture.events()).toHaveLength(0);
    // Unguarded, each of the four reached accept step 2 with `subject.id`
    // undefined, threw on `.length`, and landed in the drainer's catch.
    expect(fixture.publisher.getSnapshot().publishFaults).toBe(0);
    expect(warnsMatching("Ops publish job failed")).toBe(0);
    // The drift is still REPORTED — once for the process, not once per call.
    expect(warnsMatching(DRIFT_WARN)).toBe(1);
  });

  it("a non-string OR EMPTY tool_name is drift too — a type test, not a presence test", async () => {
    const harness = buildClaudeLaneHarness();
    for (let i = 0; i < 3; i += 1) {
      await expect(harness.fireFailure({ ...FAILURE_INPUT, tool_name: { name: "Bash" } })).resolves.toEqual({});
      // The success half is benign either way: an object `tool_name` composes a
      // family key naming "[object Object]", which no open condition matches.
      await expect(harness.fireSuccess({ ...SUCCESS_INPUT, tool_name: 42 })).resolves.toEqual({});
      // ⚠ `""` IS A STRING, so it passed a bare type test and reached accept
      // step 2, where `subject.id` failed its own LOWER bound — `rejected` spent
      // on SDK drift plus an `Ops publish rejected` line PER TOOL CALL, with no
      // latch. One character away from the guarded shape, and both harms the
      // guard exists to prevent (measured: 5 pairs ⇒ `rejected: 5`).
      await expect(harness.fireFailure({ ...FAILURE_INPUT, tool_name: "" })).resolves.toEqual({});
      await expect(harness.fireSuccess({ ...SUCCESS_INPUT, tool_name: "" })).resolves.toEqual({});
    }
    await fixture.drain();
    expect(fixture.events()).toHaveLength(0);
    expect(fixture.publisher.getSnapshot().publishFaults).toBe(0);
    // THE able-to-fail assertion for these shapes. Unguarded, an object
    // `tool_name` survives the subject-id bounds (`.length` is `undefined`, so
    // neither comparison fires) and is caught one step later by the detail
    // schema, and `""` fails the bounds outright — so both spend `rejected`,
    // D9's mis-integrated-PRODUCER signal, on SDK drift, and warn once per tool
    // call while doing it.
    expect(fixture.publisher.getSnapshot().rejected).toBe(0);
    expect(warnsMatching("Ops publish rejected")).toBe(0);
  });

  it("the drift latch is PER EVENT — the success half's drift is reported after the failure half's", async () => {
    const harness = buildClaudeLaneHarness();
    await expect(harness.fireFailure({ ...FAILURE_INPUT, tool_name: undefined })).resolves.toEqual({});
    expect(warnsMatching(DRIFT_WARN)).toBe(1);

    // ⚠ THE CASE ONE SHARED LATCH LOSES, and it loses the SILENT half. With a
    // single boolean, `PostToolUse` drifting AFTER `PostToolUseFailure` has
    // warned is never reported at all — and that is the half whose failure mode
    // is quiet: failures keep publishing while the recovery half goes dead, so
    // every condition this producer opens stays open forever with nothing in the
    // log naming the cause.
    await expect(harness.fireSuccess({ ...SUCCESS_INPUT, tool_name: undefined })).resolves.toEqual({});
    expect(warnsMatching(DRIFT_WARN)).toBe(2);
    expect(driftEvents()).toEqual(["PostToolUseFailure", "PostToolUse"]);

    // …and still latched WITHIN each event: the condition is a property of the
    // resolved CLI, so a line per call is the flood the latch exists to prevent.
    for (let i = 0; i < 3; i += 1) {
      await expect(harness.fireFailure({ ...FAILURE_INPUT, tool_name: undefined })).resolves.toEqual({});
      await expect(harness.fireSuccess({ ...SUCCESS_INPUT, tool_name: undefined })).resolves.toEqual({});
    }
    expect(warnsMatching(DRIFT_WARN)).toBe(2);
    await fixture.drain();
    expect(fixture.events()).toHaveLength(0);
    expect(fixture.publisher.getSnapshot().rejected).toBe(0);
  });

  it("a well-formed payload is unaffected, and `error` needs no guard of its own", async () => {
    const harness = buildClaudeLaneHarness();
    // `classifyToolError` is documented TOTAL for a non-string message
    // (`classifierText`), so drift in `error` costs the TOKEN and not the
    // failure record — the guard deliberately does not test it.
    await expect(harness.fireFailure({ ...FAILURE_INPUT, error: undefined })).resolves.toEqual({});
    await fixture.drain();
    expect(failures()).toHaveLength(1);
    expect(failures()[0]!.detail.errorSig).toBe("unclassified");
    expect(failures()[0]!.subject.id).toBe(FAILURE_INPUT.tool_name);
    expect(warnsMatching(DRIFT_WARN)).toBe(0);
  });

  it("the recovery half still closes a condition when the payload is well-formed", async () => {
    const harness = buildClaudeLaneHarness();
    await harness.fireFailure(FAILURE_INPUT);
    await fixture.drain();
    expect(failures()).toHaveLength(1);
    await harness.fireSuccess(SUCCESS_INPUT);
    await fixture.drain();
    expect(recoveries()).toHaveLength(1);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// AC8 — containment: nothing the producer does can reach the turn
// ───────────────────────────────────────────────────────────────────────────

describe("AC8 — containment at both capture points", () => {
  /** Every method throws — the mis-wired-publisher shape observe.ts must absorb. */
  const throwingPublisher = () =>
    new Proxy(
      {},
      {
        get: () => () => {
          throw new Error("publisher exploded");
        },
      },
    ) as unknown as OpsPublisher;

  const laneBBaseline = "Tool execution failed (boom): kaboom";

  it.each([
    ["no publisher wired", () => setOpsPublisher(undefined)],
    ["a publisher whose every method throws", () => setOpsPublisher(throwingPublisher())],
    [
      "a publisher whose insertOne always rejects",
      () => fixture.fakeDb.failAll(OPS_EVENTS_COLLECTION, "insertOne", new Error("mongo down")),
    ],
  ])("Lane B: %s — wrap() still returns the identical text and never rejects", async (_label, arrange) => {
    arrange();
    const harness = buildLaneBHarness({
      tools: {
        boom: async () => {
          throw new Error("kaboom");
        },
      },
    });
    // NEGATIVE-VERIFY TARGET: with the `try` removed from observeToolFailure,
    // the throwing-publisher row rejects here instead of resolving — breaching
    // wrap()'s structural no-throw promise. Verified by mutation during Task 5.
    await expect(harness.call("boom")).resolves.toBe(laneBBaseline);
    await expect(harness.call("boom")).resolves.toBe(laneBBaseline); // idempotent, no latched state
  });

  it.each([
    ["no publisher wired", () => setOpsPublisher(undefined)],
    ["a publisher whose every method throws", () => setOpsPublisher(throwingPublisher())],
    [
      "a publisher whose insertOne always rejects",
      () => fixture.fakeDb.failAll(OPS_EVENTS_COLLECTION, "insertOne", new Error("mongo down")),
    ],
  ])("Claude lane: %s — both hooks still resolve to {} and never reject", async (_label, arrange) => {
    arrange();
    const harness = buildClaudeLaneHarness();
    await expect(harness.fireFailure(FAILURE_INPUT)).resolves.toEqual({});
    await expect(harness.fireSuccess(SUCCESS_INPUT)).resolves.toEqual({});
  });
});
