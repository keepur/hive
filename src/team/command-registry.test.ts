import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Logger mock ─────────────────────────────────────────────────────
vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// ── TeamStore mock ──────────────────────────────────────────────────
const mockGetOrCreateDm = vi.fn().mockResolvedValue({ _id: "dm:a:b", type: "dm", members: ["a", "b"] });
const mockRenameChannel = vi.fn().mockResolvedValue(true);
const mockGetChannel = vi.fn().mockResolvedValue({ _id: "general", name: "#general", members: ["agent-a", "agent-b"] });

const mockTeamStore = {
  getOrCreateDm: mockGetOrCreateDm,
  renameChannel: mockRenameChannel,
  getChannel: mockGetChannel,
} as any;

import { CommandRegistry } from "./command-registry.js";

describe("CommandRegistry", () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new CommandRegistry(mockTeamStore);
  });

  it("has core commands registered", () => {
    const commands = registry.list();
    const names = commands.map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("new");
    expect(names).toContain("rename");
    expect(names).toContain("members");
  });

  it("executes /help and returns command list", async () => {
    const { found, result } = await registry.execute("help", {
      channelId: "test",
      senderId: "user",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(true);
    expect(result).toContain("/help");
    expect(result).toContain("/new");
  });

  it("returns found=false for unknown commands", async () => {
    const { found } = await registry.execute("nonexistent", {
      channelId: "test",
      senderId: "user",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(false);
  });

  it("executes /new and creates DM", async () => {
    const { found, result } = await registry.execute("new", {
      channelId: "test",
      senderId: "user-1",
      senderName: "User",
      args: ["jessica"],
    });
    expect(found).toBe(true);
    expect(result).toContain("DM ready");
    expect(mockGetOrCreateDm).toHaveBeenCalledWith("user-1", "jessica", "User");
  });

  it("/new returns usage when no agent specified", async () => {
    const { found, result } = await registry.execute("new", {
      channelId: "test",
      senderId: "user-1",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(true);
    expect(result).toContain("Usage");
  });

  it("executes /rename", async () => {
    const { found, result } = await registry.execute("rename", {
      channelId: "general",
      senderId: "user-1",
      senderName: "User",
      args: ["New", "Name"],
    });
    expect(found).toBe(true);
    expect(result).toContain("Renamed");
    expect(mockRenameChannel).toHaveBeenCalledWith("general", "New Name");
  });

  it("executes /members", async () => {
    const { found, result } = await registry.execute("members", {
      channelId: "general",
      senderId: "user-1",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(true);
    expect(result).toContain("agent-a");
    expect(result).toContain("agent-b");
  });

  it("accepts custom skill commands", async () => {
    registry.register({
      def: { name: "order-status", source: "skill", description: "Check order status" },
      execute: async (ctx) => `Order ${ctx.args[0]} is shipped`,
    });

    const commands = registry.list();
    expect(commands.find((c) => c.name === "order-status")).toBeDefined();

    const { found, result } = await registry.execute("order-status", {
      channelId: "test",
      senderId: "user",
      senderName: "User",
      args: ["12345"],
    });
    expect(found).toBe(true);
    expect(result).toBe("Order 12345 is shipped");
  });

  it("handles command execution errors gracefully", async () => {
    registry.register({
      def: { name: "failing", source: "skill", description: "Always fails" },
      execute: async () => {
        throw new Error("boom");
      },
    });

    const { found, result } = await registry.execute("failing", {
      channelId: "test",
      senderId: "user",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(true);
    expect(result).toContain("Command failed");
  });
});
