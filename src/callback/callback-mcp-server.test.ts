import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ name: opts.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    handler,
  })),
}));

import { buildCallbackMcpForTurn, buildCallbackTools } from "./callback-mcp-server.js";
import type { CallbackTurnContext } from "./callback-mcp-server.js";

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

function makeFakeDb(state: { inserted: any[] }): any {
  return {
    collection: () => ({
      insertOne: vi.fn(async (doc: any) => {
        state.inserted.push(doc);
        return { insertedId: { toString: () => "abc123" } };
      }),
      find: vi.fn(() => ({
        sort: vi.fn(() => ({
          toArray: vi.fn(async () => []),
        })),
      })),
      updateOne: vi.fn(async () => ({ modifiedCount: 0 })),
    }),
  };
}

describe("callback-mcp-server (in-process)", () => {
  it("schedule_callback persists per-turn source from the mutable context ref", async () => {
    const inserted: any[] = [];
    const ctx: { current: CallbackTurnContext } = {
      current: {
        workItemId: "callback-origin",
        channelId: "C1",
        threadId: "T1",
        adapterId: "slack",
      },
    };
    const tools = buildCallbackTools({ db: makeFakeDb({ inserted }), agentId: "alice", context: ctx });

    const handler = getHandler(tools, "schedule_callback");
    const res = await handler({ delay: "5m", context: "Check status" });
    expect(res.isError).toBeFalsy();
    expect(inserted).toHaveLength(1);
    expect(inserted[0].agentId).toBe("alice");
    expect(inserted[0].source.channelId).toBe("C1");
    expect(inserted[0].source.threadId).toBe("T1");
    expect(inserted[0].source.adapterId).toBe("slack");
    expect(inserted[0]).not.toHaveProperty("workItemId");
    expect(inserted[0].source).not.toHaveProperty("workItemId");
    expect(JSON.stringify(inserted[0])).not.toContain("callback-origin");
    expect(JSON.stringify(res)).not.toContain("callback-origin");
    expect(Object.keys(inserted[0].source).sort()).toEqual([
      "adapterId",
      "channelId",
      "channelKind",
      "channelLabel",
      "slackThreadTs",
      "slackTs",
      "threadId",
    ]);

    // Mutate ref → next call should see the new context.
    ctx.current = { channelId: "C2", threadId: "T2" };
    await handler({ delay: "1m", context: "Second" });
    expect(inserted).toHaveLength(2);
    expect(inserted[1].source.channelId).toBe("C2");
  });

  it("KPR-453: alternate callback builder reads supplied runtime identity", () => {
    const identity = vi.fn(() => "alternate-callback");
    buildCallbackMcpForTurn({
      db: makeFakeDb({ inserted: [] }),
      agentId: "alice",
      get workItemId() {
        return identity();
      },
    });
    expect(identity).toHaveBeenCalledTimes(1);
    expect(() => buildCallbackMcpForTurn({ db: makeFakeDb({ inserted: [] }), agentId: "alice" })).not.toThrow();
  });

  it("schedule_callback rejects malformed delay strings", async () => {
    const inserted: any[] = [];
    const tools = buildCallbackTools({
      db: makeFakeDb({ inserted }),
      agentId: "alice",
      context: { current: {} },
    });

    const handler = getHandler(tools, "schedule_callback");
    const res = await handler({ delay: "not-a-delay", context: "ctx" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid delay format/);
    expect(inserted).toHaveLength(0);
  });

  it("cancel_callback rejects invalid ObjectId", async () => {
    const tools = buildCallbackTools({
      db: makeFakeDb({ inserted: [] }),
      agentId: "alice",
      context: { current: {} },
    });
    const handler = getHandler(tools, "cancel_callback");
    const res = await handler({ callbackId: "not-an-objectid" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Invalid callback ID/);
  });
});
