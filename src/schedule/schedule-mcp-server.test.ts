import { describe, it, expect, vi } from "vitest";

// Mock MongoDB to prevent top-level await client.connect() from failing
vi.mock("mongodb", () => ({
  MongoClient: vi.fn().mockImplementation(() => ({
    connect: vi.fn().mockResolvedValue(undefined),
    db: vi.fn().mockReturnValue({
      collection: vi.fn().mockReturnValue({
        findOne: vi.fn().mockResolvedValue(null),
        updateOne: vi.fn().mockResolvedValue({}),
      }),
    }),
    close: vi.fn(),
  })),
}));

// Mock MCP SDK to prevent stdio transport from starting
vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => ({
  McpServer: vi.fn().mockImplementation(() => ({
    registerTool: vi.fn(),
    connect: vi.fn().mockResolvedValue(undefined),
  })),
}));
vi.mock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
  StdioServerTransport: vi.fn(),
}));

import { validateMinInterval } from "./schedule-mcp-server.js";

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
