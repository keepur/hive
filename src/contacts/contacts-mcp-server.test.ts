import { describe, it, expect, vi } from "vitest";

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((opts: { name: string }) => ({ name: opts.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, _schema: unknown, handler: any) => ({
    name,
    description,
    handler,
  })),
}));

import { buildContactsTools } from "./contacts-mcp-server.js";

function getHandler(tools: any[], name: string): any {
  const t = tools.find((x) => x.name === name);
  if (!t) throw new Error(`tool ${name} not registered`);
  return t.handler;
}

describe("contacts-mcp-server (in-process)", () => {
  it("contacts_search returns the empty-state message when nothing matches", async () => {
    const collection = {
      find: vi.fn(() => ({
        limit: vi.fn(() => ({ toArray: vi.fn(async () => []) })),
      })),
      countDocuments: vi.fn(async () => 0),
    };
    const db = { collection: () => collection };
    const tools = buildContactsTools({ db: db as any });
    const handler = getHandler(tools, "contacts_search");

    const res = await handler({ query: "no-such-thing", limit: 5 });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/No contacts found/);
  });

  it("contacts_get returns not-found when ObjectId resolves to no doc", async () => {
    const collection = {
      findOne: vi.fn(async () => null),
    };
    const db = { collection: () => collection };
    const tools = buildContactsTools({ db: db as any });
    const handler = getHandler(tools, "contacts_get");

    // Valid 24-char hex but no document.
    const res = await handler({ id: "deadbeefdeadbeefdeadbeef" });
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/No contact found with ID/);
  });

  it("contacts_get reports the underlying error when given a malformed id", async () => {
    const collection = {
      findOne: vi.fn(),
    };
    const db = { collection: () => collection };
    const tools = buildContactsTools({ db: db as any });
    const handler = getHandler(tools, "contacts_get");

    const res = await handler({ id: "not-a-valid-objectid" });
    expect(res.isError).toBe(true);
  });
});
