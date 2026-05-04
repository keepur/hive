import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ name: opts.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    handler,
  })),
}));

import { validateMinInterval, buildScheduleTools } from "./schedule-mcp-server.js";

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

describe("validateMinInterval", () => {
  it("accepts valid 15-minute intervals", () => {
    expect(validateMinInterval("*/15 * * * *")).toBeNull();
    expect(validateMinInterval("*/30 * * * *")).toBeNull();
    expect(validateMinInterval("0 8 * * 1-5")).toBeNull();
    expect(validateMinInterval("0 6 * * 0")).toBeNull();
  });

  it("rejects intervals under 15 minutes", () => {
    expect(validateMinInterval("*/5 * * * *")).toContain("too frequent");
    expect(validateMinInterval("*/10 * * * *")).toContain("too frequent");
    expect(validateMinInterval("*/1 * * * *")).toContain("too frequent");
  });

  it("rejects every-minute wildcards", () => {
    expect(validateMinInterval("* * * * *")).toContain("every minute");
  });

  it("allows wildcard minutes with restricted hour (known gap — runs every minute of that hour)", () => {
    expect(validateMinInterval("* 8 * * *")).toBeNull();
  });

  it("rejects comma-separated minutes too close together", () => {
    expect(validateMinInterval("0,5 * * * *")).toContain("too close");
    expect(validateMinInterval("0,10,20 * * * *")).toContain("too close");
  });

  it("accepts comma-separated minutes with enough gap", () => {
    expect(validateMinInterval("0,15,30,45 * * * *")).toBeNull();
    expect(validateMinInterval("0,30 * * * *")).toBeNull();
  });

  it("rejects malformed cron", () => {
    expect(validateMinInterval("* *")).toContain("need 5 fields");
    expect(validateMinInterval("hello")).toContain("need 5 fields");
  });
});

describe("schedule-mcp-server (in-process)", () => {
  function makeFakeDb(initialDoc: any): { db: any; updates: any[] } {
    const updates: any[] = [];
    const collection = {
      findOne: vi.fn(async () => initialDoc),
      updateOne: vi.fn(async (filter: any, update: any) => {
        updates.push({ filter, update });
        return { matchedCount: 1 };
      }),
    };
    return { db: { collection: () => collection }, updates };
  }

  it("my_schedules lists active schedules", async () => {
    const { db } = makeFakeDb({ _id: "alice", schedule: [{ cron: "*/15 * * * *", task: "ping" }] });
    const tools = buildScheduleTools({ db, agentId: "alice" });
    const handler = getHandler(tools, "my_schedules");

    const res = await handler({});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toContain("ping");
    expect(res.content[0].text).toContain("Active Schedules");
  });

  it("my_schedule_add rejects too-frequent intervals", async () => {
    const { db, updates } = makeFakeDb({ _id: "alice", schedule: [] });
    const tools = buildScheduleTools({ db, agentId: "alice" });
    const handler = getHandler(tools, "my_schedule_add");

    const res = await handler({ cron: "*/1 * * * *", task: "x", reason: "test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/too frequent/);
    expect(updates).toHaveLength(0);
  });

  it("my_schedule_remove returns isError when task not found", async () => {
    const { db } = makeFakeDb({ _id: "alice", schedule: [{ cron: "*/15 * * * *", task: "other" }] });
    const tools = buildScheduleTools({ db, agentId: "alice" });
    const handler = getHandler(tools, "my_schedule_remove");

    const res = await handler({ task: "missing", reason: "test" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/No schedule found/);
  });
});
