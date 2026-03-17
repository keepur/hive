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

import { parseClaudeOutput, detectEscalation, resolveTaskStatus } from "./output-parser.js";
import { CodeTaskManager } from "./code-task-manager.js";
import type { CodeTaskContext } from "./code-task-manager.js";

// ── Helpers ─────────────────────────────────────────────────────────
function makeContext(): CodeTaskContext {
  return {
    agentId: "test-agent",
    adapterId: "",
    channelId: "",
    channelKind: "",
    channelLabel: "",
    threadId: "",
    slackTs: "",
    slackThreadTs: "",
  };
}

// ── Output Parser Tests ─────────────────────────────────────────────
describe("parseClaudeOutput", () => {
  it("parses valid Claude Code JSON output", () => {
    const json = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: "abc-123",
      result: "Done — implemented feature X",
      total_cost_usd: 0.42,
      duration_ms: 12345,
      num_turns: 5,
    });

    const output = parseClaudeOutput(json);
    expect(output).not.toBeNull();
    expect(output!.sessionId).toBe("abc-123");
    expect(output!.result).toBe("Done — implemented feature X");
    expect(output!.subtype).toBe("success");
    expect(output!.costUsd).toBe(0.42);
    expect(output!.durationMs).toBe(12345);
    expect(output!.numTurns).toBe(5);
    expect(output!.isError).toBe(false);
  });

  it("returns null for empty string", () => {
    expect(parseClaudeOutput("")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(parseClaudeOutput("{not json}")).toBeNull();
  });

  it("returns null for non-result JSON", () => {
    const json = JSON.stringify({ type: "system", subtype: "init" });
    expect(parseClaudeOutput(json)).toBeNull();
  });

  it("handles missing optional fields", () => {
    const json = JSON.stringify({ type: "result" });
    const output = parseClaudeOutput(json);
    expect(output).not.toBeNull();
    expect(output!.sessionId).toBeNull();
    expect(output!.result).toBe("");
    expect(output!.costUsd).toBe(0);
  });

  it("parses error output", () => {
    const json = JSON.stringify({
      type: "result",
      subtype: "error_max_turns",
      is_error: true,
      result: "Hit max turns",
      total_cost_usd: 1.5,
      num_turns: 100,
    });

    const output = parseClaudeOutput(json);
    expect(output!.subtype).toBe("error_max_turns");
    expect(output!.isError).toBe(true);
  });
});

describe("detectEscalation", () => {
  it("detects NEEDS_CONTEXT status", () => {
    const result = `
Status: NEEDS_CONTEXT
Question: Which ProjectController version should I use?
Context: There are two versions in src/modules/project/
    `;

    const esc = detectEscalation(result);
    expect(esc).not.toBeNull();
    expect(esc!.status).toBe("NEEDS_CONTEXT");
    expect(esc!.question).toContain("ProjectController");
    expect(esc!.context).toContain("two versions");
  });

  it("detects BLOCKED status", () => {
    const result = `
**Status:** BLOCKED
**Question:** Tests fail consistently due to missing fixture data
    `;

    const esc = detectEscalation(result);
    expect(esc).not.toBeNull();
    expect(esc!.status).toBe("BLOCKED");
    expect(esc!.question).toContain("Tests fail");
  });

  it("returns null for DONE status", () => {
    const result = `
Status: DONE
What I implemented: Added the new endpoint
Files changed: 3
    `;

    expect(detectEscalation(result)).toBeNull();
  });

  it("returns null for empty result", () => {
    expect(detectEscalation("")).toBeNull();
  });

  it("returns null for no status marker", () => {
    expect(detectEscalation("Everything worked fine")).toBeNull();
  });

  it("handles case-insensitive matching", () => {
    const result = "Status: needs_context\nQuestion: What should I do?";
    const esc = detectEscalation(result);
    expect(esc).not.toBeNull();
    expect(esc!.status).toBe("NEEDS_CONTEXT");
  });
});

describe("resolveTaskStatus", () => {
  it("returns completed for exit 0 + success", () => {
    const output = { sessionId: null, result: "", subtype: "success", costUsd: 0, durationMs: 0, numTurns: 0, isError: false };
    expect(resolveTaskStatus(0, output, null)).toBe("completed");
  });

  it("returns needs_input for escalation", () => {
    const output = { sessionId: null, result: "", subtype: "success", costUsd: 0, durationMs: 0, numTurns: 0, isError: false };
    const escalation = { status: "BLOCKED" as const, question: "help", context: "" };
    expect(resolveTaskStatus(0, output, escalation)).toBe("needs_input");
  });

  it("returns needs_input for max_turns", () => {
    const output = { sessionId: null, result: "", subtype: "error_max_turns", costUsd: 0, durationMs: 0, numTurns: 100, isError: true };
    expect(resolveTaskStatus(1, output, null)).toBe("needs_input");
  });

  it("returns needs_input for max_budget", () => {
    const output = { sessionId: null, result: "", subtype: "error_max_budget_usd", costUsd: 5, durationMs: 0, numTurns: 50, isError: true };
    expect(resolveTaskStatus(1, output, null)).toBe("needs_input");
  });

  it("returns failed for non-zero exit without escalation", () => {
    const output = { sessionId: null, result: "Error occurred", subtype: "error", costUsd: 0, durationMs: 0, numTurns: 0, isError: true };
    expect(resolveTaskStatus(1, output, null)).toBe("failed");
  });

  it("returns completed for exit 0 with no output", () => {
    expect(resolveTaskStatus(0, null, null)).toBe("completed");
  });

  it("returns failed for non-zero exit with no output", () => {
    expect(resolveTaskStatus(1, null, null)).toBe("failed");
  });
});

// ── CodeTaskManager HTTP API Tests ──────────────────────────────────

const PORT = 39102;
const AUTH_TOKEN = "test-token-ct";
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN_DIR = "/tmp/fake-plugin-dir";

let manager: CodeTaskManager;

beforeAll(async () => {
  manager = new CodeTaskManager(PORT, AUTH_TOKEN, PLUGIN_DIR, 2, () => {});
  await manager.start();
});

afterAll(() => {
  manager.stop();
});

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

  it("accepts authenticated GET /tasks", async () => {
    const res = await fetch(`${BASE}/tasks`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
  });
});

describe("spawn and status", () => {
  it("spawns a code task and tracks it", async () => {
    // Use echo as a fake "claude" command — it won't produce valid JSON
    // but we can test the spawn/status/list lifecycle
    const res = await fetch(`${BASE}/tasks`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        prompt: "test task",
        cwd: "/tmp",
        context: makeContext(),
      }),
    });

    // Will fail because 'claude' might not produce valid output, but spawn should work
    // or fail gracefully (command not found = exit 1)
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("id");
    expect(body.status).toBe("running");

    // Check that the task is tracked (may still be running or already finished)
    const statusRes = await fetch(`${BASE}/tasks/${body.id}`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(statusRes.status).toBe(200);
    const status = await statusRes.json();
    expect(["running", "completed", "failed"]).toContain(status.status);
  });

  it("lists tasks filtered by agent", async () => {
    const res = await fetch(`${BASE}/tasks?agentId=test-agent`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("tasks");
    expect(Array.isArray(body.tasks)).toBe(true);
  });

  it("returns 404 for unknown task", async () => {
    const res = await fetch(`${BASE}/tasks/00000000-0000-0000-0000-000000000000`, {
      headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
    });
    expect(res.status).toBe(404);
  });
});

describe("concurrency limit", () => {
  it("rejects tasks when concurrency limit reached", async () => {
    // Create a manager with concurrency 1
    const mgr = new CodeTaskManager(PORT + 1, AUTH_TOKEN, PLUGIN_DIR, 1, () => {});
    await mgr.start();

    try {
      // Spawn a long-running task (sleep 10)
      const res1 = await fetch(`http://127.0.0.1:${PORT + 1}/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "long task",
          cwd: "/tmp",
          context: makeContext(),
        }),
      });
      expect(res1.status).toBe(200);

      // Try to spawn another — should fail with 429
      const res2 = await fetch(`http://127.0.0.1:${PORT + 1}/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "another task",
          cwd: "/tmp",
          context: makeContext(),
        }),
      });
      expect(res2.status).toBe(429);
    } finally {
      mgr.stop();
    }
  });
});

describe("respond", () => {
  it("rejects respond for non-existent task", async () => {
    const res = await fetch(`${BASE}/tasks/00000000-0000-0000-0000-000000000000/respond`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${AUTH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ response: "test" }),
    });
    expect(res.status).toBe(400);
  });
});
