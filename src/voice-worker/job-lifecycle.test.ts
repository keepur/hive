import { expect, it, vi } from "vitest";
import { withJobLifecycle } from "./job-lifecycle.js";

function controlledContext() {
  let shutdown!: () => Promise<void>;
  return {
    ctx: {
      addShutdownCallback(callback: () => Promise<void>) {
        shutdown = callback;
      },
    },
    shutdown: () => shutdown(),
  };
}

it("registers shutdown tracking before reporting entry or running work", async () => {
  const order: string[] = [];
  const harness = controlledContext();

  await expect(
    withJobLifecycle(
      {
        addShutdownCallback(callback) {
          order.push("registered");
          harness.ctx.addShutdownCallback(callback);
        },
      },
      {
        entered: () => order.push("entered"),
        completed: () => order.push("completed"),
      },
      async () => {
        order.push("work");
        throw new Error("configuration failed");
      },
    ),
  ).rejects.toThrow("configuration failed");

  expect(order).toEqual(["registered", "entered", "work"]);
  await harness.shutdown();
  expect(order).toEqual(["registered", "entered", "work", "completed"]);
});

it("does not report completion when entry returns normally before SDK shutdown", async () => {
  const harness = controlledContext();
  const reporter = { entered: vi.fn(), completed: vi.fn() };

  await withJobLifecycle(harness.ctx, reporter, async () => {});

  expect(reporter.entered).toHaveBeenCalledOnce();
  expect(reporter.completed).not.toHaveBeenCalled();
  await harness.shutdown();
  expect(reporter.completed).toHaveBeenCalledOnce();
});

it("runs early cleanup during shutdown after a pre-session failure", async () => {
  const harness = controlledContext();
  const events: string[] = [];

  await expect(
    withJobLifecycle(
      harness.ctx,
      {
        entered: () => events.push("entered"),
        completed: () => events.push("completed"),
      },
      async ({ setEarlyCleanup }) => {
        setEarlyCleanup(async () => {
          events.push("early-cleanup");
        });
        throw new Error("metadata failed");
      },
    ),
  ).rejects.toThrow("metadata failed");

  await harness.shutdown();
  expect(events).toEqual(["entered", "early-cleanup", "completed"]);
});

it("waits for delegated ordered cleanup before reporting completion", async () => {
  const harness = controlledContext();
  const events: string[] = [];
  let finishCleanup!: () => void;

  await withJobLifecycle(
    harness.ctx,
    {
      entered: () => events.push("entered"),
      completed: () => events.push("completed"),
    },
    async ({ delegateCleanup }) => {
      finishCleanup = delegateCleanup();
    },
  );

  let shutdownSettled = false;
  const shutdown = harness.shutdown().then(() => {
    shutdownSettled = true;
  });
  await Promise.resolve();
  expect(shutdownSettled).toBe(false);
  expect(events).toEqual(["entered"]);
  finishCleanup();
  await shutdown;
  expect(events).toEqual(["entered", "completed"]);
});

it("does not report completion when early cleanup rejects", async () => {
  const harness = controlledContext();
  const reporter = { entered: vi.fn(), completed: vi.fn() };

  await withJobLifecycle(harness.ctx, reporter, async ({ setEarlyCleanup }) => {
    setEarlyCleanup(async () => {
      throw new Error("mongo close failed");
    });
  });

  await expect(harness.shutdown()).rejects.toThrow("mongo close failed");
  expect(reporter.completed).not.toHaveBeenCalled();
});

it("propagates a completion write failure instead of claiming cleanup", async () => {
  const harness = controlledContext();

  await withJobLifecycle(
    harness.ctx,
    {
      entered: () => {},
      completed: () => {
        throw new Error("completion persistence failed");
      },
    },
    async () => {},
  );

  await expect(harness.shutdown()).rejects.toThrow("completion persistence failed");
});
