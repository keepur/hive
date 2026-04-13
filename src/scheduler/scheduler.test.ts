import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock config before importing scheduler (scheduler reads config at module level)
vi.mock("../config.js", () => ({
  config: {
    scheduler: { heartbeatIntervalMs: 60_000 },
    events: { retentionDays: 7 },
    team: { enabled: false },
  },
}));

// Mock logger
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock MongoDB to avoid real connections
vi.mock("mongodb", () => ({
  MongoClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    db: vi.fn().mockReturnValue({
      collection: vi.fn().mockReturnValue({
        createIndex: vi.fn().mockResolvedValue("ok"),
        find: vi.fn().mockReturnValue({ toArray: vi.fn().mockResolvedValue([]) }),
      }),
    }),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

import { Scheduler } from "./scheduler.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { WorkItem } from "../types/work-item.js";

// ---------------------------------------------------------------------------
// Minimal stubs
// ---------------------------------------------------------------------------

function makeAgentConfig(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    name: "Test Agent",
    model: "haiku",
    icon: "",
    channels: ["general"],
    homeBase: undefined,
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    coreServers: [],
    delegateServers: [],
    delegatePrompts: {},
    soul: "",
    systemPrompt: "",
    schedule: [],
    budgetUsd: 10,
    maxTurns: 200,
    maxConcurrent: 3,
    timeoutMs: 300_000,
    disabled: false,
    autonomy: {
      bypassPermissions: false,
      denyList: [],
      runDangerously: false,
      allowedDirectories: [],
    },
    ...overrides,
  };
}

function makeRegistry(agents: AgentConfig[]) {
  const map = new Map(agents.map((a) => [a.id, a]));
  return {
    getAll: () => agents,
    get: (id: string) => map.get(id),
  };
}

function makeAgentManager() {
  return {
    sendMessage: vi.fn().mockResolvedValue({ text: "ok" }),
  };
}

function makeMemoryManager() {
  return { pull: vi.fn().mockResolvedValue(undefined) };
}

function makeHealthReporter() {
  return { writeToMemory: vi.fn().mockResolvedValue(undefined) };
}

// ---------------------------------------------------------------------------
// Helper: inject a cron job directly and trigger checkCronJobs
// ---------------------------------------------------------------------------

interface CronJobInternal {
  agentId: string;
  cron: string;
  task: string;
  lastRun: Date | null;
}

function injectJobAndFire(scheduler: Scheduler, job: CronJobInternal): void {
  // checkCronJobs is private; cast to any for unit-test access — this is
  // intentional to avoid adding a public test-only surface to production code.
  const s = scheduler as any;
  s.cronJobs = [job];
  s.checkCronJobs();
}

// A cron expression that always matches any date: "* * * * *"
const ALWAYS = "* * * * *";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Scheduler.checkCronJobs — homeBase dispatch channel selection", () => {
  let dispatched: WorkItem[];
  let onDispatch: (item: WorkItem) => void;

  beforeEach(() => {
    dispatched = [];
    onDispatch = (item) => dispatched.push(item);
  });

  it("uses agent.homeBase when set, regardless of channels", () => {
    const agent = makeAgentConfig({
      id: "agent-a",
      homeBase: "mokie-huang",
      channels: ["general"],
    });
    const scheduler = new Scheduler(
      makeAgentManager() as any,
      makeMemoryManager() as any,
      makeHealthReporter() as any,
      makeRegistry([agent]) as any,
      onDispatch,
    );

    injectJobAndFire(scheduler, { agentId: "agent-a", cron: ALWAYS, task: "morning-digest", lastRun: null });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].source.id).toBe("mokie-huang");
  });

  it("falls back to channels[0] when homeBase is undefined", () => {
    const agent = makeAgentConfig({
      id: "agent-b",
      homeBase: undefined,
      channels: ["general", "ops"],
    });
    const scheduler = new Scheduler(
      makeAgentManager() as any,
      makeMemoryManager() as any,
      makeHealthReporter() as any,
      makeRegistry([agent]) as any,
      onDispatch,
    );

    injectJobAndFire(scheduler, { agentId: "agent-b", cron: ALWAYS, task: "report", lastRun: null });

    expect(dispatched).toHaveLength(1);
    expect(dispatched[0].source.id).toBe("general");
  });

  it("skips dispatch (no throw) when homeBase is undefined and channels is empty", () => {
    const agent = makeAgentConfig({
      id: "agent-c",
      homeBase: undefined,
      channels: [],
    });
    const scheduler = new Scheduler(
      makeAgentManager() as any,
      makeMemoryManager() as any,
      makeHealthReporter() as any,
      makeRegistry([agent]) as any,
      onDispatch,
    );

    // Should not throw and should not dispatch
    expect(() =>
      injectJobAndFire(scheduler, { agentId: "agent-c", cron: ALWAYS, task: "noop", lastRun: null }),
    ).not.toThrow();
    expect(dispatched).toHaveLength(0);
  });

  it("skips dispatch for a disabled agent", () => {
    const agent = makeAgentConfig({
      id: "agent-d",
      homeBase: "agent-d",
      channels: ["general"],
      disabled: true,
    });
    const scheduler = new Scheduler(
      makeAgentManager() as any,
      makeMemoryManager() as any,
      makeHealthReporter() as any,
      makeRegistry([agent]) as any,
      onDispatch,
    );

    injectJobAndFire(scheduler, { agentId: "agent-d", cron: ALWAYS, task: "report", lastRun: null });

    expect(dispatched).toHaveLength(0);
  });

  it("does not double-dispatch a job that already ran this minute", () => {
    const agent = makeAgentConfig({
      id: "agent-e",
      homeBase: "agent-e",
      channels: ["general"],
    });
    const scheduler = new Scheduler(
      makeAgentManager() as any,
      makeMemoryManager() as any,
      makeHealthReporter() as any,
      makeRegistry([agent]) as any,
      onDispatch,
    );

    const job: CronJobInternal = { agentId: "agent-e", cron: ALWAYS, task: "daily", lastRun: null };
    const s = scheduler as any;
    s.cronJobs = [job];

    // First fire
    s.checkCronJobs();
    // Second fire (same minute — lastRun is now set)
    s.checkCronJobs();

    expect(dispatched).toHaveLength(1);
  });
});
