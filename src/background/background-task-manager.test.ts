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
async function waitForCompletion(taskId: string, timeoutMs = 5000): Promise<any> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await fetch(`${BASE}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    const body = await res.json();
    if (body.status !== "running") return body;
    await new Promise((r) => setTimeout(r, 50));
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

afterAll(() => {
  manager.stop();
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
