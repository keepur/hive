import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

// ── Logger mock ─────────────────────────────────────────────────────
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { BackgroundTaskManager } from "./background-task-manager.js";
import type { BackgroundTaskContext } from "./background-task-manager.js";

// ── Helpers ─────────────────────────────────────────────────────────
function makeContext(): BackgroundTaskContext {
  return {
    agentId: "",
    adapterId: "",
    channelId: "",
    channelKind: "",
    channelLabel: "",
    threadId: "",
    slackTs: "",
    slackThreadTs: "",
  };
}

/** Poll task status until it leaves "running", with timeout. */
async function waitForCompletion(taskId: string, timeoutMs = 10000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const body = await res.json();
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Task ${taskId} did not complete within ${timeoutMs}ms`);
}

// ── Setup ───────────────────────────────────────────────────────────
const PORT = 39100;
const AUTH_TOKEN = "test-token-123";
const TASKS_DIR = `/tmp/hive-bg-tasks-test-${process.pid}`;
const BASE = `http://127.0.0.1:${PORT}`;

let manager: BackgroundTaskManager;

beforeAll(async () => {
  manager = new BackgroundTaskManager(PORT, AUTH_TOKEN, TASKS_DIR, () => {});
  await manager.start();
});

afterAll(async () => {
  await manager.stop();
});

// ── Tests ───────────────────────────────────────────────────────────
describe("authentication", () => {
  it("rejects unauthenticated POST /tasks with 401", async () => {
    const res = await fetch(`${BASE}/tasks`, { method: "POST" });
    expect(res.status).toBe(401);
  });

  it("rejects wrong auth token with 401", async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(res.status).toBe(401);
  });

  it("accepts correctly authenticated POST /tasks", async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "echo",
        args: ["hello"],
        context: makeContext(),
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body.status).toBe("running");
  });

  it("rejects unauthenticated GET /tasks with 401", async () => {
    const res = await fetch(`${BASE}/tasks`);
    expect(res.status).toBe(401);
  });

  it("rejects unauthenticated GET /tasks/:id with 401", async () => {
    const res = await fetch(`${BASE}/tasks/some-uuid`);
    expect(res.status).toBe(401);
  });

  it("accepts authenticated GET /tasks", async () => {
    const res = await fetch(`${BASE}/tasks`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("structured spawn (no shell)", () => {
  it("spawns command with args array", async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "echo",
        args: ["hello", "world"],
        context: makeContext(),
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("id");

    const status = await waitForCompletion(body.id);
    expect(status.status).toBe("completed");
  });

  it("handles command with spaces in args", async () => {
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "echo",
        args: ["hello world", "arg with spaces"],
        context: makeContext(),
      }),
    });
    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body).toHaveProperty("id");
  });
});

// ── Process Lifecycle Tests ────────────────────────────────────────

describe("stop() — process cleanup", () => {
  it("sends SIGTERM to running tasks on stop", async () => {
    const stopMgr = new BackgroundTaskManager(PORT + 10, AUTH_TOKEN, TASKS_DIR, () => {});
    await stopMgr.start();

    // Spawn a long-running process
    const res = await fetch(`http://127.0.0.1:${PORT + 10}/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "sleep",
        args: ["60"],
        context: makeContext(),
      }),
    });
    expect(res.status).toBe(200);
    const { id } = await res.json();

    // Verify it's running
    const statusRes = await fetch(`http://127.0.0.1:${PORT + 10}/tasks/${id}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const status = await statusRes.json();
    expect(status.status).toBe("running");

    // Stop should kill it
    await stopMgr.stop();

    // The PID should no longer be alive
    const tasks = (stopMgr as unknown as { tasks: Map<string, { pid: number | null }> }).tasks;
    const task = tasks.get(id);
    if (task?.pid) {
      let alive = true;
      try {
        process.kill(task.pid, 0);
      } catch {
        alive = false;
      }
      expect(alive).toBe(false);
    }
  });

  it("stop() is safe to call with no running tasks", async () => {
    const emptyMgr = new BackgroundTaskManager(PORT + 11, AUTH_TOKEN, TASKS_DIR, () => {});
    await emptyMgr.start();
    // Should not throw
    await emptyMgr.stop();
  });

  it("stop() handles already-dead processes gracefully", async () => {
    const deadMgr = new BackgroundTaskManager(PORT + 12, AUTH_TOKEN, TASKS_DIR, () => {});
    await deadMgr.start();

    // Spawn a fast-exiting process
    const res = await fetch(`http://127.0.0.1:${PORT + 12}/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        command: "echo",
        args: ["done"],
        context: makeContext(),
      }),
    });
    expect(res.status).toBe(200);

    // Wait for it to finish — use the dead manager's port
    const { id } = await res.json();
    const start = Date.now();
    while (Date.now() - start < 10000) {
      const r = await fetch(`http://127.0.0.1:${PORT + 12}/tasks/${id}`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      const b = await r.json();
      if (b.status !== "running") break;
      await new Promise((r) => setTimeout(r, 100));
    }

    // Stop should not throw even though the process is already dead
    await deadMgr.stop();
  });
});
