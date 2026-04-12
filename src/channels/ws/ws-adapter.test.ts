import { describe, it, expect, vi } from "vitest";
import { WsAdapter } from "./ws-adapter.js";
import type { AgentConfig, AgentState } from "../../types/agent-config.js";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../../files/file-processor.js", () => ({
  processImageBuffer: vi.fn(),
  processFileBuffer: vi.fn(),
}));

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "test-agent",
    name: "Test Agent",
    model: "claude-haiku-3-5",
    channels: ["general"],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    schedule: [],
    budgetUsd: 10,
    maxTurns: 10,
    icon: ":robot:",
    coreServers: [],
    delegateServers: [],
    soul: "",
    systemPrompt: "",
    autonomy: {},
    ...overrides,
  };
}

const mockDeviceRegistry = {
  verifyPairingCode: vi.fn(),
  createDevice: vi.fn(),
  listDevices: vi.fn(),
  updateDevice: vi.fn(),
  deactivateDevice: vi.fn(),
  refreshPairingCode: vi.fn(),
  verifyToken: vi.fn(),
  updateLastSeen: vi.fn(),
} as any;

describe("WsAdapter.buildAgentList()", () => {
  it("returns empty array when no agentRegistry", () => {
    const adapter = new WsAdapter(3200, mockDeviceRegistry, "test-secret", undefined, undefined, undefined, undefined);

    const result = (adapter as any).buildAgentList();
    expect(result).toEqual([]);
  });

  it("maps agent config fields correctly", () => {
    const agent = makeAgent({
      id: "rae",
      name: "Rae",
      icon: ":wave:",
      title: "Receptionist",
      model: "claude-haiku-3-5",
      channels: ["general", "support"],
    });

    const mockAgentRegistry = {
      getAll: vi.fn().mockReturnValue([agent]),
    } as any;

    const mockAgentManager = {
      getState: vi.fn().mockReturnValue(undefined),
    } as any;

    const adapter = new WsAdapter(
      3200,
      mockDeviceRegistry,
      "test-secret",
      undefined,
      undefined,
      mockAgentRegistry,
      mockAgentManager,
    );

    const result = (adapter as any).buildAgentList();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("rae");
    expect(result[0].name).toBe("Rae");
    expect(result[0].icon).toBe(":wave:");
    expect(result[0].title).toBe("Receptionist");
    expect(result[0].model).toBe("claude-haiku-3-5");
    expect(result[0].channels).toEqual(["general", "support"]);
  });

  it("merges runtime state when available", () => {
    const agent = makeAgent({ id: "jasper" });
    const state: Partial<AgentState> = {
      status: "processing",
      messagesProcessed: 42,
      lastActivity: new Date("2026-04-12T10:00:00.000Z"),
    };

    const mockAgentRegistry = {
      getAll: vi.fn().mockReturnValue([agent]),
    } as any;

    const mockAgentManager = {
      getState: vi.fn().mockReturnValue(state),
    } as any;

    const adapter = new WsAdapter(
      3200,
      mockDeviceRegistry,
      "test-secret",
      undefined,
      undefined,
      mockAgentRegistry,
      mockAgentManager,
    );

    const result = (adapter as any).buildAgentList();
    expect(result[0].status).toBe("processing");
    expect(result[0].messagesProcessed).toBe(42);
    expect(result[0].lastActivity).toBe("2026-04-12T10:00:00.000Z");
  });

  it("uses defaults when agent has no runtime state", () => {
    const agent = makeAgent({ id: "milo" });

    const mockAgentRegistry = {
      getAll: vi.fn().mockReturnValue([agent]),
    } as any;

    const mockAgentManager = {
      getState: vi.fn().mockReturnValue(undefined),
    } as any;

    const adapter = new WsAdapter(
      3200,
      mockDeviceRegistry,
      "test-secret",
      undefined,
      undefined,
      mockAgentRegistry,
      mockAgentManager,
    );

    const result = (adapter as any).buildAgentList();
    expect(result[0].status).toBe("idle");
    expect(result[0].messagesProcessed).toBe(0);
    expect(result[0].lastActivity).toBeNull();
  });

  it("deduplicates and sorts tools from coreServers and delegateServers", () => {
    const agent = makeAgent({
      coreServers: ["slack", "memory", "crm-search"],
      delegateServers: ["memory", "brave-search", "crm-search"],
    });

    const mockAgentRegistry = {
      getAll: vi.fn().mockReturnValue([agent]),
    } as any;

    const mockAgentManager = {
      getState: vi.fn().mockReturnValue(undefined),
    } as any;

    const adapter = new WsAdapter(
      3200,
      mockDeviceRegistry,
      "test-secret",
      undefined,
      undefined,
      mockAgentRegistry,
      mockAgentManager,
    );

    const result = (adapter as any).buildAgentList();
    expect(result[0].tools).toEqual(["brave-search", "crm-search", "memory", "slack"]);
  });

  it("maps schedule correctly", () => {
    const agent = makeAgent({
      schedule: [
        { cron: "0 9 * * 1-5", task: "Send morning digest" },
        { cron: "0 0 * * *", task: "Nightly cleanup" },
      ],
    });

    const mockAgentRegistry = {
      getAll: vi.fn().mockReturnValue([agent]),
    } as any;

    const mockAgentManager = {
      getState: vi.fn().mockReturnValue(undefined),
    } as any;

    const adapter = new WsAdapter(
      3200,
      mockDeviceRegistry,
      "test-secret",
      undefined,
      undefined,
      mockAgentRegistry,
      mockAgentManager,
    );

    const result = (adapter as any).buildAgentList();
    expect(result[0].schedule).toEqual([
      { cron: "0 9 * * 1-5", task: "Send morning digest" },
      { cron: "0 0 * * *", task: "Nightly cleanup" },
    ]);
  });

  it("maps title to null when undefined", () => {
    const agent = makeAgent({ title: undefined });

    const mockAgentRegistry = {
      getAll: vi.fn().mockReturnValue([agent]),
    } as any;

    const mockAgentManager = {
      getState: vi.fn().mockReturnValue(undefined),
    } as any;

    const adapter = new WsAdapter(
      3200,
      mockDeviceRegistry,
      "test-secret",
      undefined,
      undefined,
      mockAgentRegistry,
      mockAgentManager,
    );

    const result = (adapter as any).buildAgentList();
    expect(result[0].title).toBeNull();
  });
});
