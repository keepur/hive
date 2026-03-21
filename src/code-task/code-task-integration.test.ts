import { describe, it, expect, vi, beforeAll, afterAll, afterEach } from "vitest";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

// ── Logger mock ─────────────────────────────────────────────────────
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { CodeTaskManager } from "./code-task-manager.js";
import type { CodeTaskContext } from "./code-task-manager.js";
import type { WorkItem } from "../types/work-item.js";

// ── Helpers ─────────────────────────────────────────────────────────
const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(__dirname, "test-fixtures");

const PORT = 39300;
const AUTH_TOKEN = "test-integration";
const PLUGIN_DIR = "/tmp/fake-plugin-dir";
const TASKS_DIR = `/tmp/hive-code-tasks-integ-${process.pid}`;

function headers(extra?: Record<string, string>) {
  return {
    Authorization: `Bearer ${AUTH_TOKEN}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

function makeContext(overrides?: Partial<CodeTaskContext>): CodeTaskContext {
  return {
    agentId: "test-agent",
    adapterId: "test-adapter",
    channelId: "C-test-channel",
    channelKind: "slack",
    channelLabel: "#test",
    threadId: "thread-123",
    slackTs: "1234567890.123456",
    slackThreadTs: "1234567890.000000",
    ...overrides,
  };
}

function api(port: number, method: string, path: string, body?: object) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    headers: headers(),
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

/** Wait for a task to leave "running" status */
async function waitForTask(port: number, taskId: string, timeoutMs = 5000): Promise<Record<string, unknown>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const res = await api(port, "GET", `/tasks/${taskId}`);
    const data = (await res.json()) as Record<string, unknown>;
    if (data.status !== "running") return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Task ${taskId} still running after ${timeoutMs}ms`);
}

// ── Full Lifecycle Tests ────────────────────────────────────────────

describe("integration: full lifecycle", () => {
  const port = PORT;
  let manager: CodeTaskManager;
  const completions: WorkItem[] = [];

  beforeAll(async () => {
    manager = new CodeTaskManager(
      port,
      AUTH_TOKEN,
      PLUGIN_DIR,
      2,
      TASKS_DIR,
      (item) => {
        completions.push(item);
      },
      { cliBin: resolve(FIXTURES, "fake-claude-success.sh") },
    );
    await manager.start();
  });

  afterAll(() => manager.stop());
  afterEach(() => {
    completions.length = 0;
  });

  it("spawns a task, parses output, and fires a completion WorkItem", async () => {
    const res = await api(port, "POST", "/tasks", {
      prompt: "implement the feature",
      cwd: "/tmp",
      context: makeContext(),
    });
    expect(res.status).toBe(200);
    const { id } = (await res.json()) as { id: string };

    // Wait for the process to finish
    const status = await waitForTask(port, id);

    expect(status.status).toBe("completed");
    expect(status.sessionId).toBe("test-session-abc-123");
    expect(status.costUsd).toBe(0.42);
    expect(status.numTurns).toBe(5);
    expect(status.escalation).toBeNull();

    // Completion WorkItem should have been dispatched
    // Give the async fireCompletion a tick to resolve
    await new Promise((r) => setTimeout(r, 200));
    expect(completions.length).toBe(1);

    const item = completions[0];
    expect(item.text).toContain("[Code task completed]");
    expect(item.text).toContain("$0.42");
    expect(item.text).toContain("Turns: 5");

    // Routing context preserved
    expect(item.source.kind).toBe("slack");
    expect(item.source.id).toBe("C-test-channel");
    expect(item.threadId).toBe("thread-123");
    expect(item.meta?.slackTs).toBe("1234567890.123456");
    expect(item.meta?.slackThreadTs).toBe("1234567890.000000");
  });
});

describe("integration: escalation lifecycle", () => {
  const port = PORT + 1;
  let manager: CodeTaskManager;
  const completions: WorkItem[] = [];

  beforeAll(async () => {
    manager = new CodeTaskManager(
      port,
      AUTH_TOKEN,
      PLUGIN_DIR,
      2,
      TASKS_DIR,
      (item) => {
        completions.push(item);
      },
      { cliBin: resolve(FIXTURES, "fake-claude-escalation.sh") },
    );
    await manager.start();
  });

  afterAll(() => manager.stop());
  afterEach(() => {
    completions.length = 0;
  });

  it("detects escalation in output and sets needs_input status", async () => {
    const res = await api(port, "POST", "/tasks", {
      prompt: "implement the feature",
      cwd: "/tmp",
      context: makeContext(),
    });
    const { id } = (await res.json()) as { id: string };

    const status = await waitForTask(port, id);

    expect(status.status).toBe("needs_input");
    expect(status.sessionId).toBe("test-session-escalation-456");
    expect(status.costUsd).toBe(1.05);

    // Escalation details
    const escalation = status.escalation as { status: string; question: string; context: string };
    expect(escalation.status).toBe("NEEDS_CONTEXT");
    expect(escalation.question).toContain("ProjectController");
    expect(escalation.context).toContain("v1 is deprecated");

    // Completion WorkItem should contain escalation text
    await new Promise((r) => setTimeout(r, 200));
    expect(completions.length).toBe(1);
    expect(completions[0].text).toContain("[Code task needs input]");
    expect(completions[0].text).toContain("code_respond");
    expect(completions[0].text).toContain("ProjectController");
  });
});

describe("integration: failure lifecycle", () => {
  const port = PORT + 2;
  let manager: CodeTaskManager;
  const completions: WorkItem[] = [];

  beforeAll(async () => {
    manager = new CodeTaskManager(
      port,
      AUTH_TOKEN,
      PLUGIN_DIR,
      2,
      TASKS_DIR,
      (item) => {
        completions.push(item);
      },
      { cliBin: resolve(FIXTURES, "fake-claude-failure.sh") },
    );
    await manager.start();
  });

  afterAll(() => manager.stop());
  afterEach(() => {
    completions.length = 0;
  });

  it("handles process failure and fires failure WorkItem", async () => {
    const res = await api(port, "POST", "/tasks", {
      prompt: "do something",
      cwd: "/tmp",
      context: makeContext(),
    });
    const { id } = (await res.json()) as { id: string };

    const status = await waitForTask(port, id);

    expect(status.status).toBe("failed");
    expect(status.exitCode).toBe(1);
    expect(status.sessionId).toBe("test-session-fail-789");

    await new Promise((r) => setTimeout(r, 200));
    expect(completions.length).toBe(1);
    expect(completions[0].text).toContain("[Code task failed]");
    expect(completions[0].text).toContain("exited with code 1");
  });
});

describe("integration: concurrency with real processes", () => {
  const port = PORT + 3;
  let manager: CodeTaskManager;

  beforeAll(async () => {
    // Use slow fixture — stays running for 30s
    manager = new CodeTaskManager(port, AUTH_TOKEN, PLUGIN_DIR, 1, TASKS_DIR, () => {}, {
      cliBin: resolve(FIXTURES, "fake-claude-slow.sh"),
    });
    await manager.start();
  });

  afterAll(() => manager.stop());

  it("rejects second task when first is still running", async () => {
    // Start a slow task
    const res1 = await api(port, "POST", "/tasks", {
      prompt: "slow task",
      cwd: "/tmp",
      context: makeContext(),
    });
    expect(res1.status).toBe(200);

    // Verify it's running
    const { id } = (await res1.json()) as { id: string };
    const status1 = await api(port, "GET", `/tasks/${id}`);
    const data1 = (await status1.json()) as Record<string, unknown>;
    expect(data1.status).toBe("running");

    // Second task should be rejected
    const res2 = await api(port, "POST", "/tasks", {
      prompt: "another task",
      cwd: "/tmp",
      context: makeContext(),
    });
    expect(res2.status).toBe(429);

    const body2 = (await res2.json()) as { error: string };
    expect(body2.error).toContain("concurrency");
  });
});
