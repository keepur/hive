import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ name: opts.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    handler,
  })),
}));

import { buildTeamTools } from "./team-mcp-server.js";

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

function makeFakeDb() {
  const messageInserts: any[] = [];
  const pendingInserts: any[] = [];
  const collectionByName: Record<string, any> = {
    team_messages: {
      insertOne: vi.fn(async (doc: any) => {
        messageInserts.push(doc);
        return { insertedId: "m1" };
      }),
    },
    team_pending_requests: {
      insertOne: vi.fn(async (doc: any) => {
        pendingInserts.push(doc);
        return { insertedId: "p1" };
      }),
      findOne: vi.fn(async () => null),
      updateOne: vi.fn(async () => ({ modifiedCount: 0 })),
    },
  };
  const db = { collection: (name: string) => collectionByName[name] };
  return { db, messageInserts, pendingInserts };
}

describe("team-mcp-server (in-process)", () => {
  it("send_message refuses to send to self", async () => {
    const { db } = makeFakeDb();
    const tools = buildTeamTools({
      db: db as any,
      agentId: "alice",
      getAgentIds: () => ["alice", "bob"],
    });
    const handler = getHandler(tools, "send_message");

    const res = await handler({ targetAgentId: "alice", text: "hi" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/yourself/);
  });

  it("send_message rejects unknown target agent", async () => {
    const { db } = makeFakeDb();
    const tools = buildTeamTools({
      db: db as any,
      agentId: "alice",
      getAgentIds: () => ["alice", "bob"],
    });
    const handler = getHandler(tools, "send_message");

    const res = await handler({ targetAgentId: "ghost", text: "hi" });
    expect(res.isError).toBe(true);
    expect(res.content[0].text).toMatch(/Unknown agent/);
  });

  it("send_message fire-and-forget persists message + pending request", async () => {
    const { db, messageInserts, pendingInserts } = makeFakeDb();
    const tools = buildTeamTools({
      db: db as any,
      agentId: "alice",
      getAgentIds: () => ["alice", "bob"],
    });
    const handler = getHandler(tools, "send_message");

    const res = await handler({ targetAgentId: "bob", text: "hello" });
    expect(res.isError).toBeFalsy();
    expect(messageInserts).toHaveLength(1);
    expect(messageInserts[0].text).toBe("hello");
    expect(pendingInserts).toHaveLength(1);
    expect(pendingInserts[0].type).toBe("fire_and_forget");
  });

  it("list_agents excludes self", async () => {
    const { db } = makeFakeDb();
    const tools = buildTeamTools({
      db: db as any,
      agentId: "alice",
      getAgentIds: () => ["alice", "bob", "carol"],
    });
    const handler = getHandler(tools, "list_agents");

    const res = await handler({});
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).not.toMatch(/- alice/);
    expect(res.content[0].text).toMatch(/- bob/);
    expect(res.content[0].text).toMatch(/- carol/);
  });
});
