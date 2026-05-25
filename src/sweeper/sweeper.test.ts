import { describe, expect, it, vi } from "vitest";
import { Sweeper, type SweepResult, type SweeperConfig, type SweeperTargets } from "./sweeper.js";

const emptyResult = (component: string): SweepResult => ({
  component,
  pruned: 0,
  retried: 0,
  bytesFreed: 0,
  errors: [],
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeConfig(): SweeperConfig {
  return {
    intervalMs: 30_000,
    threadTtlMs: 60_000,
    taskFileTtlMs: 60_000,
    meetingSessionTtlMs: 60_000,
    cacheTtlMs: 60_000,
    memorySweepIntervalHours: 999,
    dreamConfig: {
      enabled: true,
      idleThresholdMinutes: 30,
      cooldownMinutes: 60,
      similarityThreshold: 0.85,
      patternMinCount: 3,
      maxClustersPerRun: 20,
      maxContradictionPairsPerRun: 30,
      maxPromotionsPerRun: 10,
      maxBudgetUsd: 0.1,
    },
  };
}

function makeTargets(
  dream: () => Promise<{
    merged: number;
    contradictions: number;
    promoted: number;
    flaggedForReview: number;
    errors: string[];
  }>,
): SweeperTargets {
  const idleSince = new Date(Date.now() - 31 * 60 * 1000);
  return {
    dispatcher: { sweep: vi.fn(() => emptyResult("dispatcher")) } as any,
    slackAdapters: [],
    bgTaskManager: { sweep: vi.fn(async () => emptyResult("bg-task-manager")) } as any,
    slackGateways: [],
    agentManager: {
      sweep: vi.fn(() => emptyResult("agent-manager")),
      getAllStates: vi.fn(() => [{ status: "idle", lastActivity: idleSince }]),
    } as any,
    memoryLifecycle: {
      sweep: vi.fn(async () => emptyResult("memory-lifecycle")),
      dream: vi.fn(dream),
    } as any,
  };
}

describe("Sweeper autoDream", () => {
  it("does not start a second autoDream while one is already running", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T18:00:00Z"));

    const dreamRun = deferred<{
      merged: number;
      contradictions: number;
      promoted: number;
      flaggedForReview: number;
      errors: string[];
    }>();
    const targets = makeTargets(() => dreamRun.promise);
    const sweeper = new Sweeper(makeConfig(), targets);

    const firstSweep = sweeper.sweep();
    await vi.waitFor(() => expect((targets.memoryLifecycle!.dream as any).mock.calls.length).toBe(1));

    const secondSweep = await sweeper.sweep();
    expect((targets.memoryLifecycle!.dream as any).mock.calls.length).toBe(1);
    expect(secondSweep.some((r) => r.component === "autodream")).toBe(false);

    dreamRun.resolve({ merged: 0, contradictions: 0, promoted: 0, flaggedForReview: 0, errors: [] });
    await firstSweep;

    vi.useRealTimers();
  });

  it("reserves cooldown before running autoDream so failures do not retry every sweep", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-20T18:00:00Z"));

    const targets = makeTargets(async () => {
      throw new Error("limit");
    });
    const sweeper = new Sweeper(makeConfig(), targets);

    const firstSweep = await sweeper.sweep();
    expect(firstSweep.some((r) => r.component === "autodream" && r.errors.length === 1)).toBe(true);

    const secondSweep = await sweeper.sweep();
    expect((targets.memoryLifecycle!.dream as any).mock.calls.length).toBe(1);
    expect(secondSweep.some((r) => r.component === "autodream")).toBe(false);

    vi.useRealTimers();
  });
});
