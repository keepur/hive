import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ name: opts.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    handler,
  })),
}));

import { buildWorkerPoolTools, type WorkerPoolToolDeps } from "./worker-pool-mcp-server.js";
import type { WorkerPoolTurnContext } from "./meeting-worker-pool.js";

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

function makeFixture(overrides?: { context?: WorkerPoolTurnContext; agentId?: string }) {
  const pool = {
    dispatch: vi.fn(async () => "Worker dispatched (claim abc123)."),
    status: vi.fn(async () => "abc123 — running — Jasper — 2m — fetch numbers"),
    cancel: vi.fn(async () => "Cancelled claim abc123."),
  };
  const context: { current: WorkerPoolTurnContext } = {
    current: overrides?.context ?? {
      adapterId: "slack-main",
      channelId: "C123",
      channelKind: "slack",
      channelLabel: "conf-tahoe",
      threadId: "1724680000.100",
      slackTs: "1724680001.200",
      slackThreadTs: "1724680000.100",
    },
  };
  const deps = {
    pool: pool as unknown as WorkerPoolToolDeps["pool"],
    agentId: overrides?.agentId ?? "boss",
    context,
  };
  const tools = buildWorkerPoolTools(deps);
  return { pool, context, tools, agentId: deps.agentId };
}

describe("worker-pool-mcp-server (in-process)", () => {
  it("registers exactly the three worker tools", () => {
    const { tools } = makeFixture();
    expect(tools.map((t: any) => t.name)).toEqual(["worker_dispatch", "worker_status", "worker_cancel"]);
  });

  it("worker_dispatch forwards bossAgentId, task and the current turn context, returning the pool's text", async () => {
    const { tools, pool, context, agentId } = makeFixture();
    const handler = getHandler(tools, "worker_dispatch");

    const res = await handler({ task: "Fetch the Q2 revenue numbers from the CRM" });

    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toBe("Worker dispatched (claim abc123).");
    expect(pool.dispatch).toHaveBeenCalledTimes(1);
    expect(pool.dispatch).toHaveBeenCalledWith({
      bossAgentId: agentId,
      task: "Fetch the Q2 revenue numbers from the CRM",
      context: context.current,
    });
  });

  it("worker_dispatch reads the mutable context ref per call, not at build time", async () => {
    const { tools, pool, context } = makeFixture();
    const handler = getHandler(tools, "worker_dispatch");

    await handler({ task: "Fetch the Q2 revenue numbers from the CRM" });

    context.current = {
      adapterId: "slack-main",
      channelId: "C999",
      channelKind: "slack",
      channelLabel: "conf-summit",
      threadId: "1724690000.500",
    };
    await handler({ task: "Fetch the Q3 pipeline from the CRM" });

    expect(pool.dispatch).toHaveBeenCalledTimes(2);
    expect(pool.dispatch.mock.calls[0]![0].context.channelId).toBe("C123");
    expect(pool.dispatch.mock.calls[1]![0].context).toEqual(context.current);
    expect(pool.dispatch.mock.calls[1]![0].context.threadId).toBe("1724690000.500");
  });

  it("worker_dispatch shapes a pool rejection into a structured error instead of throwing", async () => {
    const { tools, pool } = makeFixture();
    pool.dispatch.mockRejectedValueOnce(new Error("mongo down"));
    const handler = getHandler(tools, "worker_dispatch");

    const res = await handler({ task: "Fetch the Q2 revenue numbers from the CRM" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^worker_dispatch error: /);
    expect(res.content[0].text).toMatch(/mongo down/);
  });

  it("worker_status refuses without a thread on the turn, and never touches the pool", async () => {
    const { tools, pool } = makeFixture({ context: { channelKind: "slack", channelLabel: "conf-tahoe" } });
    const handler = getHandler(tools, "worker_status");

    const res = await handler({});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toBe("worker_status: no thread context on this turn.");
    expect(pool.status).not.toHaveBeenCalled();
  });

  it("worker_status passes the current threadId through and returns the pool's listing", async () => {
    const { tools, pool } = makeFixture();
    const handler = getHandler(tools, "worker_status");

    const res = await handler({});

    expect(res.isError).toBeFalsy();
    expect(pool.status).toHaveBeenCalledWith("1724680000.100");
    expect(res.content[0].text).toBe("abc123 — running — Jasper — 2m — fetch numbers");
  });

  it("worker_cancel passes the claim id and the calling agent id", async () => {
    const { tools, pool, agentId } = makeFixture();
    const handler = getHandler(tools, "worker_cancel");

    const res = await handler({ claimId: "abc123" });

    expect(res.isError).toBeFalsy();
    expect(pool.cancel).toHaveBeenCalledWith("abc123", agentId);
    expect(res.content[0].text).toBe("Cancelled claim abc123.");
  });

  it("worker_cancel shapes a pool rejection into a structured error", async () => {
    const { tools, pool } = makeFixture();
    pool.cancel.mockRejectedValueOnce(new Error("boom"));
    const handler = getHandler(tools, "worker_cancel");

    const res = await handler({ claimId: "abc123" });

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^worker_cancel error: .*boom/);
  });

  it("worker_status shapes a pool rejection into a structured error", async () => {
    const { tools, pool } = makeFixture();
    pool.status.mockRejectedValueOnce(new Error("read failed"));
    const handler = getHandler(tools, "worker_status");

    const res = await handler({});

    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/^worker_status error: .*read failed/);
  });
});
