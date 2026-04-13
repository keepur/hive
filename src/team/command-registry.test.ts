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

// ── AgentResolver stub ──────────────────────────────────────────────
const KNOWN_AGENTS = [
  { id: "jessica", name: "Jessica" },
  { id: "chloe", name: "Chloe" },
];
const mockResolver = vi.fn((input: string) => {
  const byId = KNOWN_AGENTS.find((a) => a.id === input);
  if (byId) return byId;
  const byName = KNOWN_AGENTS.find((a) => a.name.toLowerCase() === input.toLowerCase());
  return byName ?? null;
});

import { CommandRegistry } from "./command-registry.js";

describe("CommandRegistry", () => {
  let registry: CommandRegistry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new CommandRegistry(mockTeamStore, mockResolver);
  });

  it("has core commands registered", () => {
    const names = registry.list().map((c) => c.name);
    expect(names).toContain("help");
    expect(names).toContain("dm");
    expect(names).toContain("rename");
    expect(names).toContain("members");
  });

  it("does NOT register legacy /new", () => {
    const names = registry.list().map((c) => c.name);
    expect(names).not.toContain("new");
  });

  it("has() reports registered commands accurately", () => {
    expect(registry.has("dm")).toBe(true);
    expect(registry.has("help")).toBe(true);
    expect(registry.has("new")).toBe(false);
    expect(registry.has("nonexistent")).toBe(false);
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
    expect(result).toContain("/dm");
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

  it("/dm with valid agent id creates DM", async () => {
    const { found, result } = await registry.execute("dm", {
      channelId: "test",
      senderId: "user-1",
      senderName: "User",
      args: ["jessica"],
    });
    expect(found).toBe(true);
    expect(result).toContain("DM ready");
    expect(mockGetOrCreateDm).toHaveBeenCalledWith("user-1", "jessica", "User");
  });

  it("/dm with display name (case-insensitive) creates DM", async () => {
    const { found, result } = await registry.execute("dm", {
      channelId: "test",
      senderId: "user-1",
      senderName: "User",
      args: ["CHLOE"],
    });
    expect(found).toBe(true);
    expect(result).toContain("DM ready");
    expect(mockGetOrCreateDm).toHaveBeenCalledWith("user-1", "chloe", "User");
  });

  it("/dm with unknown agent returns error, no DB write", async () => {
    const { found, result } = await registry.execute("dm", {
      channelId: "test",
      senderId: "user-1",
      senderName: "User",
      args: ["not-a-real-agent"],
    });
    expect(found).toBe(true);
    expect(result).toBe("Unknown agent: not-a-real-agent");
    expect(mockGetOrCreateDm).not.toHaveBeenCalled();
  });

  it("/dm with no args returns usage", async () => {
    const { found, result } = await registry.execute("dm", {
      channelId: "test",
      senderId: "user-1",
      senderName: "User",
      args: [],
    });
    expect(found).toBe(true);
    expect(result).toContain("Usage: /dm");
    expect(mockGetOrCreateDm).not.toHaveBeenCalled();
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
