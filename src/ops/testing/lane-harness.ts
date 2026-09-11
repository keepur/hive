/**
 * KPR-454 chunk 4, Task 5 — the two lane harnesses.
 *
 * ⚠ A PLAIN MODULE, NOT a `.test.ts` file, and that is a measurement
 * constraint rather than a taste one: under this repo's vitest, a consumer
 * importing a `.test.ts` file RE-REGISTERS that file's suites and file-scope
 * hooks into the importer, so `capture-points.integration.test.ts`'s
 * `beforeEach`/`vi.mock` would silently become active for
 * `acceptance.integration.test.ts`'s cases and this suite would run twice
 * under two different fixtures. The repository has ZERO cross-`.test.ts`
 * imports; the established pattern is a plain module
 * (`src/obligations/testing/{fake-db,harness,refusals}.ts`, and this ticket's
 * own `src/ops/testing/fake-db.ts`). A plain module also gets
 * `tsc --noEmit` coverage, which `.test.ts` files do not.
 *
 * Both `capture-points.integration.test.ts` (this task) and chunk 5's
 * `acceptance.integration.test.ts` import from here; NEITHER imports the
 * other.
 *
 * ⚠ `src/ops/testing/**` is EXCLUDED from chunk 5's AC7/AC15 source scans over
 * `src/ops/**` — deliberately, because a lane harness legitimately constructs
 * runner machinery and `RunResult`-shaped baselines; those scans constrain the
 * producer's own sources, not its test doubles.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { tmpdir } from "node:os";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { AgentRunner, type WorkItemContext } from "../../agents/agent-runner.js";
import { ToolBridge, type ToolBridgeOptions } from "../../agents/provider-adapters/tool-bridge.js";
import { classifyToolTransport, type HiveToolInventoryEntry } from "../../agents/provider-adapters/tool-transport.js";
import type { AgentConfig } from "../../types/agent-config.js";
import { OpsPublisher } from "../publisher.js";
import { setOpsPublisher, __resetOpsPublisherForTests } from "../publisher-singleton.js";
import { OPS_EVENTS_COLLECTION, type OpsEvent } from "../types.js";
import { FakeDb } from "./fake-db.js";

const RETENTION_DAYS = 90;

// ───────────────────────────────────────────────────────────────────────────
// The shared publisher fixture. Both lanes need a WIRED publisher (an unset
// singleton makes every observe call a no-op by construction), so the
// construction lives here once rather than being cloned into each harness and
// again into chunk 5's file.
// ───────────────────────────────────────────────────────────────────────────

export interface OpsFixture {
  fakeDb: FakeDb;
  publisher: OpsPublisher;
  /** The append-only log's rows, read straight off the fixture (adds no `operations` entry). */
  events(): OpsEvent[];
  /** THE drain barrier — `enqueue()` is synchronous and fires `void drain()`. */
  drain(): Promise<void>;
  dispose(): Promise<void>;
}

/**
 * A live publisher, initialized and registered as the module-global singleton.
 * `init()` must be awaited before the singleton is set for anything that
 * asserts on stored rows — an uninitialized publisher holds no reason map and
 * C5 fails every publish closed.
 */
export async function buildOpsFixture(options: { publisher?: OpsPublisher; init?: boolean } = {}): Promise<OpsFixture> {
  const fakeDb = new FakeDb();
  const publisher = options.publisher ?? new OpsPublisher(fakeDb.db, RETENTION_DAYS);
  if (options.init !== false) await publisher.init();
  setOpsPublisher(publisher);
  return {
    fakeDb,
    publisher,
    events: () => fakeDb.collection(OPS_EVENTS_COLLECTION).rows as unknown as OpsEvent[],
    drain: () => publisher.__drainForTests(),
    dispose: async () => {
      await publisher.stop();
      __resetOpsPublisherForTests();
    },
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Claude lane
// ───────────────────────────────────────────────────────────────────────────

export function makeHarnessAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "harness-agent",
    name: "HarnessDisplayName", // deliberately NOT the slug — D6's whole point
    aliases: [],
    roles: [],
    model: "claude-haiku-4-5",
    channels: [],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 25,
    icon: "",
    coreServers: [],
    delegateServers: [],
    soul: "",
    systemPrompt: "You are a harness agent.",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    ...overrides,
  };
}

function makeMemoryManager(): any {
  return {
    read: async () => null,
    write: async () => undefined,
    list: async () => [],
    delete: async () => undefined,
    history: async () => [],
    rollback: async () => undefined,
    getHotTierPrompt: async () => null,
  };
}

export interface ClaudeLaneHarness {
  runner: AgentRunner;
  /** The real map `buildHooks()` returned — the one the SDK would be handed. */
  hooks: Partial<Record<HookEvent, HookCallbackMatcher[]>>;
  /** Mark the runner aborted through its real `abort()`, so `wasAborted` is the production getter. */
  markAborted(): void;
  /** Fire the registered PostToolUseFailure callback and return its result. */
  fireFailure(input: Record<string, unknown>): Promise<unknown>;
  /** Fire the registered PostToolUse callback and return its result. */
  fireSuccess(input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Builds a REAL `AgentRunner` and reads its REAL hook map. The construction is
 * copied from `agent-runner.test.ts`'s `makeRunner` +
 * `it("buildHooks installs deny-all when preToolUseHooks throws
 * (fail-closed)")` rather than re-derived, so the private-method seam
 * (`(runner as any).buildHooks()`) and the runner's positional shape are the
 * ones an existing green test already depends on.
 *
 * `archetype`/`archetypeConfig` are passed through on `config`, so a caller
 * that has registered a THROWING archetype gets the fail-closed deny-all arm
 * for free — which is exactly AC13's direction-1 drive.
 */
export function buildClaudeLaneHarness(
  options: { config?: Partial<AgentConfig>; workItemContext?: WorkItemContext } = {},
): ClaudeLaneHarness {
  const runner = new AgentRunner(makeHarnessAgentConfig(options.config), makeMemoryManager(), [], new Map(), "{}");
  // `send()` is the production writer of this ref (agent-runner.ts, the
  // `this.workItemContextRef.current = context` line); a hook-map drive never
  // calls send(), so the harness sets it at the same seam. The hook reads
  // `.current` AT FIRE TIME (KPR-453 canon), so a later write here is visible
  // to an already-built hook — which is what makes the "identity is not
  // captured at build time" claim drivable.
  (runner as any).workItemContextRef.current = options.workItemContext;
  const hooks = (runner as any).buildHooks(options.workItemContext) as Partial<
    Record<HookEvent, HookCallbackMatcher[]>
  >;

  const fire = async (event: "PostToolUseFailure" | "PostToolUse", input: Record<string, unknown>) => {
    const matchers = hooks[event];
    if (!matchers || matchers.length !== 1 || matchers[0]!.hooks.length !== 1) {
      throw new Error(`harness: expected exactly one ${event} matcher with one callback`);
    }
    return matchers[0]!.hooks[0]!(input as any, undefined, { signal: new AbortController().signal });
  };

  return {
    runner,
    hooks,
    markAborted: () => {
      // `abort()` only latches `_aborted` when a query is active, so the
      // harness supplies the minimal active-query shape rather than writing
      // `_aborted` directly — `wasAborted` then reads through the real path.
      (runner as any).activeQuery = { close: () => {} };
      runner.abort();
    },
    fireFailure: (input) => fire("PostToolUseFailure", input),
    fireSuccess: (input) => fire("PostToolUse", input),
  };
}

/** The one literal the deny-all arm carries — the stable "after the catch" anchor (AC13, direction 2). */
export const ARCHETYPE_DENY_ALL_ANCHOR = "All tool calls blocked until the archetype is fixed.";

// ───────────────────────────────────────────────────────────────────────────
// Lane B
// ───────────────────────────────────────────────────────────────────────────

export interface LaneBHarness {
  bridge: ToolBridge;
  abortController: AbortController;
  /**
   * Runs the bridge's own `wrap()` dispatch for `name` — the single Lane B
   * capture point — and returns the model-visible text. Never throws (the
   * method's structural promise).
   */
  call(name: string, input?: unknown): Promise<string>;
  /** Every bridged tool `connect()` produced, post-`applyNameAndCapEdges`. */
  names(): string[];
}

/**
 * A REAL `ToolBridge` over a REAL in-process-free inventory: each entry is
 * declared `sdk-in-process` with a static schema and dispatched through an
 * injected behaviour, so the harness exercises `wrap()` (gate → abort check →
 * execute → contain → meter) without standing up a transport. `connect()` is
 * NOT called — `wrap()` is reached directly through the private wrapper, the
 * same seam the Claude-lane harness uses for `buildHooks`.
 */
export function buildLaneBHarness(
  options: {
    tools?: Record<string, (input: unknown) => Promise<string>>;
    bridge?: Partial<ToolBridgeOptions>;
    abortController?: AbortController;
  } = {},
): LaneBHarness {
  const abortController = options.abortController ?? new AbortController();
  const tools = options.tools ?? {};
  const bridge = new ToolBridge({
    inventory: [],
    inProcessServers: {},
    gate: async () => ({ behavior: "allow" }),
    workItemContext: undefined,
    signal: abortController.signal,
    agentId: "HarnessDisplayName",
    sessionCwd: tmpdir(),
    skillIndex: [],
    ...options.bridge,
  });
  // `wrap()` is private and is THE dispatch site under test; reaching it
  // directly is the only way to drive one named tool's success/catch pair
  // without a live transport. `applyNameAndCapEdges` is applied separately by
  // `names()` below, so the AC11 truncation claim still runs through the real
  // method rather than a restatement of it.
  const wrapped = new Map(
    Object.entries(tools).map(([name, underlying]) => [
      name,
      (bridge as any).wrap(name, "", { type: "object", properties: {} }, underlying) as {
        name: string;
        execute(input: unknown): Promise<string>;
      },
    ]),
  );
  return {
    bridge,
    abortController,
    call: async (name, input = {}) => {
      const tool = wrapped.get(name);
      if (!tool) throw new Error(`harness: no wrapped tool named ${name}`);
      return tool.execute(input);
    },
    names: () =>
      ((bridge as any).applyNameAndCapEdges([...wrapped.values()]) as Array<{ name: string }>).map((t) => t.name),
  };
}

/** A minimal inventory entry, for the cases that need `connect()`-shaped carriage. */
export function makeInventoryEntry(
  name: string,
  overrides: Partial<HiveToolInventoryEntry> = {},
): HiveToolInventoryEntry {
  return {
    ...classifyToolTransport({ name, transport: "stdio", source: "plugin" }),
    schemas: { kind: "connect-time" },
    serverConfig: { command: "node", args: [], env: {} } as never,
    ...overrides,
  };
}
