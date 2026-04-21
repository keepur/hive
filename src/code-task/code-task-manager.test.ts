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
    const output = {
      sessionId: null,
      result: "",
      subtype: "success",
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      isError: false,
    };
    expect(resolveTaskStatus(0, output, null)).toBe("completed");
  });

  it("returns needs_input for escalation", () => {
    const output = {
      sessionId: null,
      result: "",
      subtype: "success",
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      isError: false,
    };
    const escalation = { status: "BLOCKED" as const, question: "help", context: "" };
    expect(resolveTaskStatus(0, output, escalation)).toBe("needs_input");
  });

  it("returns needs_input for max_turns", () => {
    const output = {
      sessionId: null,
      result: "",
      subtype: "error_max_turns",
      costUsd: 0,
      durationMs: 0,
      numTurns: 100,
      isError: true,
    };
    expect(resolveTaskStatus(1, output, null)).toBe("needs_input");
  });

  it("returns needs_input for max_budget", () => {
    const output = {
      sessionId: null,
      result: "",
      subtype: "error_max_budget_usd",
      costUsd: 5,
      durationMs: 0,
      numTurns: 50,
      isError: true,
    };
    expect(resolveTaskStatus(1, output, null)).toBe("needs_input");
  });

  it("returns failed for non-zero exit without escalation", () => {
    const output = {
      sessionId: null,
      result: "Error occurred",
      subtype: "error",
      costUsd: 0,
      durationMs: 0,
      numTurns: 0,
      isError: true,
    };
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

// Port ranges must stay disjoint across test files — vitest runs files in
// parallel workers that share the OS port space, so overlapping hardcoded
// ports cause non-deterministic EADDRINUSE flakes. Current map:
//   background-task-manager.test.ts : 39100, 39110–39112
//   code-task-manager.test.ts       : 39121–39128  (PORT + 1..8, see below)
//   meeting-monitor.test.ts         : 39200, 39201
//   code-task-integration.test.ts   : 39300+
// This file previously used PORT=39102 and its PORT+8 slot (39110) collided
// with background-task-manager's PORT+10 — moving PORT forward by 18 gives
// a clean range with plenty of headroom before meeting-monitor.
const PORT = 39120;
const AUTH_TOKEN = "test-token-ct";
const BASE = `http://127.0.0.1:${PORT}`;
const PLUGIN_DIRS = ["/tmp/fake-plugin-dir"];
const TASKS_DIR = `/tmp/hive-code-tasks-test-${process.pid}`;

let manager: CodeTaskManager;

beforeAll(async () => {
  manager = new CodeTaskManager(PORT, AUTH_TOKEN, PLUGIN_DIRS, 2, TASKS_DIR, () => {});
  await manager.start();
});

afterAll(async () => {
  await manager.stop();
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
    const mgr = new CodeTaskManager(PORT + 1, AUTH_TOKEN, PLUGIN_DIRS, 1, TASKS_DIR, () => {});
    await mgr.start();

    try {
      // Send both requests concurrently — the first grabs the slot, the second should be rejected.
      // Using Promise.all ensures both hit the server before the event loop processes exit events.
      const [res1, res2] = await Promise.all([
        fetch(`http://127.0.0.1:${PORT + 1}/tasks`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: "task 1",
            cwd: "/tmp",
            context: makeContext(),
          }),
        }),
        fetch(`http://127.0.0.1:${PORT + 1}/tasks`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${AUTH_TOKEN}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            prompt: "task 2",
            cwd: "/tmp",
            context: makeContext(),
          }),
        }),
      ]);

      const statuses = [res1.status, res2.status].sort();
      // One should succeed (200), one should be rejected (429)
      expect(statuses).toEqual([200, 429]);
    } finally {
      await mgr.stop();
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

// ── Process Lifecycle Tests ────────────────────────────────────────

describe("stop() — process cleanup", () => {
  it("sends SIGTERM to running tasks on stop", async () => {
    // Create a manager with a long-running process (sleep)
    const mgr = new CodeTaskManager(PORT + 2, AUTH_TOKEN, PLUGIN_DIRS, 2, TASKS_DIR, () => {}, {
      cliBin: "sleep",
    });
    await mgr.start();

    try {
      // Spawn a sleep process that will take a while
      const res = await fetch(`http://127.0.0.1:${PORT + 2}/tasks`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          prompt: "60", // sleep 60 — will be killed
          cwd: "/tmp",
          context: makeContext(),
        }),
      });
      expect(res.status).toBe(200);
      const { id } = await res.json();

      // Verify it's running
      const statusRes = await fetch(`http://127.0.0.1:${PORT + 2}/tasks/${id}`, {
        headers: { Authorization: `Bearer ${AUTH_TOKEN}` },
      });
      const status = await statusRes.json();
      expect(status.status).toBe("running");

      // Stop should kill it
      await mgr.stop();

      // After stop, the process should be dead — verify via the tasks map
      const tasks = (mgr as unknown as { tasks: Map<string, { status: string; pid: number | null }> }).tasks;
      // The task may still show as "running" in the map (handleExit won't fire after stop),
      // but the PID should no longer be alive
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
    } catch {
      // Cleanup in case of failure
      await mgr.stop();
    }
  });

  it("stop() is safe to call with no running tasks", async () => {
    const mgr = new CodeTaskManager(PORT + 3, AUTH_TOKEN, PLUGIN_DIRS, 2, TASKS_DIR, () => {});
    await mgr.start();
    // Should not throw
    await mgr.stop();
  });
});

describe("reapStale()", () => {
  it("reaps tasks older than maxLifetimeMs with no recent stderr activity", async () => {
    const { spawn } = await import("node:child_process");
    const { writeFileSync, utimesSync } = await import("node:fs");

    const mgr = new CodeTaskManager(PORT + 4, AUTH_TOKEN, PLUGIN_DIRS, 2, TASKS_DIR, () => {}, {
      maxLifetimeMs: 1, // 1ms — everything is stale
      staleGraceMs: 0, // no grace
    });
    await mgr.start();

    try {
      // Spawn a real long-running process and inject it as a fake task
      const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      const stderrPath = `${TASKS_DIR}/reap-test.stderr.log`;
      writeFileSync(stderrPath, "");
      // Backdate mtime so isFileRecentlyModified can't flip true on CI clock noise
      const pastSec = Math.floor((Date.now() - 3_600_000) / 1000);
      utimesSync(stderrPath, pastSec, pastSec);

      const tasks = (mgr as unknown as { tasks: Map<string, Record<string, unknown>> }).tasks;
      tasks.set("reap-test-id", {
        id: "reap-test-id",
        status: "running",
        pid: child.pid,
        startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(), // 10h ago
        stderrPath,
        context: makeContext(),
      });

      const result = await mgr.reapStale();
      expect(result.reaped).toBe(1);
      expect(result.spared).toBe(0);

      // SIGTERM was sent — process should die shortly (reapStale schedules SIGKILL after 5s)
      // Just verify SIGTERM was sent by checking it's no longer alive after a brief wait
      await new Promise((r) => setTimeout(r, 500));
      let alive = true;
      try {
        process.kill(child.pid!, 0);
      } catch {
        alive = false;
      }
      // sleep responds to SIGTERM, so it should be dead
      expect(alive).toBe(false);
    } finally {
      await mgr.stop();
    }
  });

  it("spares tasks with recently modified stderr", async () => {
    const { spawn } = await import("node:child_process");
    const { writeFileSync } = await import("node:fs");

    const mgr = new CodeTaskManager(PORT + 5, AUTH_TOKEN, PLUGIN_DIRS, 2, TASKS_DIR, () => {}, {
      maxLifetimeMs: 1, // everything is "stale" by age
      staleGraceMs: 60_000, // 60s grace
    });
    await mgr.start();

    try {
      const child = spawn("sleep", ["60"], { detached: true, stdio: "ignore" });
      const stderrPath = `${TASKS_DIR}/spare-test.stderr.log`;
      // Write to stderr file NOW — mtime will be recent
      writeFileSync(stderrPath, "recent activity\n");

      const tasks = (mgr as unknown as { tasks: Map<string, Record<string, unknown>> }).tasks;
      tasks.set("spare-test-id", {
        id: "spare-test-id",
        status: "running",
        pid: child.pid,
        startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(), // 10h ago
        stderrPath,
        context: makeContext(),
      });

      const result = await mgr.reapStale();
      expect(result.spared).toBe(1);
      expect(result.reaped).toBe(0);

      // Cleanup — kill the sleep process
      try {
        process.kill(child.pid!, "SIGTERM");
      } catch {
        // already dead
      }
    } finally {
      await mgr.stop();
    }
  });

  it("returns zeros when no tasks are stale", async () => {
    const mgr = new CodeTaskManager(PORT + 6, AUTH_TOKEN, PLUGIN_DIRS, 2, TASKS_DIR, () => {}, {
      maxLifetimeMs: 999_999_999, // nothing is stale
    });
    await mgr.start();

    try {
      const result = await mgr.reapStale();
      expect(result.reaped).toBe(0);
      expect(result.spared).toBe(0);
    } finally {
      await mgr.stop();
    }
  });

  it("skips non-running tasks and tasks without PIDs", async () => {
    const mgr = new CodeTaskManager(PORT + 8, AUTH_TOKEN, PLUGIN_DIRS, 2, TASKS_DIR, () => {}, {
      maxLifetimeMs: 1,
      staleGraceMs: 0,
    });
    await mgr.start();

    try {
      const tasks = (mgr as unknown as { tasks: Map<string, Record<string, unknown>> }).tasks;
      // Completed task — should be skipped
      tasks.set("completed-id", {
        id: "completed-id",
        status: "completed",
        pid: 99999,
        startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
        stderrPath: "/tmp/nonexistent",
        context: makeContext(),
      });
      // Running task with no PID — should be skipped
      tasks.set("no-pid-id", {
        id: "no-pid-id",
        status: "running",
        pid: null,
        startedAt: new Date(Date.now() - 10 * 60 * 60 * 1000).toISOString(),
        stderrPath: "/tmp/nonexistent",
        context: makeContext(),
      });

      const result = await mgr.reapStale();
      expect(result.reaped).toBe(0);
      expect(result.spared).toBe(0);
    } finally {
      await mgr.stop();
    }
  });
});

describe("resume race guard", () => {
  it("prevents double-resume by flipping status atomically", async () => {
    // Inject a fake task in needs_input state directly into the tasks map
    const mgr = new CodeTaskManager(PORT + 7, AUTH_TOKEN, PLUGIN_DIRS, 2, TASKS_DIR, () => {}, {
      cliBin: "sleep",
    });
    await mgr.start();

    try {
      const tasks = (mgr as unknown as { tasks: Map<string, Record<string, unknown>> }).tasks;
      const fakeId = "00000000-aaaa-bbbb-cccc-111111111111";
      tasks.set(fakeId, {
        id: fakeId,
        prompt: "test",
        cwd: "/tmp",
        model: "",
        maxTurns: 10,
        maxBudget: 1,
        status: "needs_input",
        exitCode: 1,
        startedAt: new Date().toISOString(),
        completedAt: null,
        stdoutPath: "/tmp/fake.stdout",
        stderrPath: "/tmp/fake.stderr",
        metaPath: "/tmp/fake.meta.json",
        context: makeContext(),
        pid: null,
        sessionId: "fake-session-id",
        costUsd: 0,
        numTurns: 0,
        escalation: null,
        parentTaskId: null,
      });

      // First resume should succeed (spawns a new task)
      const res1 = await fetch(`http://127.0.0.1:${PORT + 7}/tasks/${fakeId}/respond`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ response: "first resume" }),
      });
      expect(res1.status).toBe(200);

      // Second resume should fail — status is no longer needs_input
      const res2 = await fetch(`http://127.0.0.1:${PORT + 7}/tasks/${fakeId}/respond`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${AUTH_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ response: "second resume" }),
      });
      expect(res2.status).toBe(400);
      const body = await res2.json();
      expect(body.error).toContain("not needs_input");
    } finally {
      await mgr.stop();
    }
  });
});
