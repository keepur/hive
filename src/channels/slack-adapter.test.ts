import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { SlackAdapter } from "./slack-adapter.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { SlackGateway } from "../slack/slack-gateway.js";
import type { IncomingMessage } from "../types/agent-config.js";
import type { WorkItem } from "../types/work-item.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MessageHandler = (msg: IncomingMessage) => void | Promise<void>;

interface GatewayStub {
  gateway: SlackGateway;
  emit: (msg: IncomingMessage) => Promise<void>;
  setThreadStatus: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
  resolveUserName: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeGatewayStub(): GatewayStub {
  let messageHandler: MessageHandler | null = null;
  const setThreadStatus = vi.fn().mockResolvedValue(undefined);
  const postMessage = vi.fn().mockResolvedValue(undefined);
  const resolveUserName = vi.fn(async (u: string) => u);
  const start = vi.fn().mockResolvedValue(undefined);
  const stop = vi.fn().mockResolvedValue(undefined);

  const gateway = {
    onMessage: (h: MessageHandler) => {
      messageHandler = h;
    },
    onThreadStarted: () => {},
    onThreadContextChanged: () => {},
    addIntegrationChannels: () => {},
    setThreadStatus,
    postMessage,
    resolveUserName,
    setSuggestedPrompts: vi.fn().mockResolvedValue(undefined),
    start,
    stop,
    client: {} as unknown as SlackGateway["client"],
  };

  return {
    gateway: gateway as unknown as SlackGateway,
    setThreadStatus,
    postMessage,
    resolveUserName,
    start,
    stop,
    emit: async (msg) => {
      if (!messageHandler) throw new Error("onMessage handler not registered");
      await messageHandler(msg);
    },
  };
}

interface RegistryStubOpts {
  /** Map of channel-name → agent definition (channels[0] picks owner) */
  channelAgents?: Record<string, { id: string; name?: string; disabled?: boolean }>;
  /** Map of agent id → agent definition (looked up by `get(id)`) */
  agents?: Record<string, { id: string; name?: string; disabled?: boolean; icon?: string }>;
}

function makeRegistryStub(opts: RegistryStubOpts = {}): AgentRegistry {
  const byChannel = opts.channelAgents ?? {};
  const byId: Record<string, { id: string; name?: string; disabled?: boolean; icon?: string }> = {
    ...(opts.agents ?? {}),
  };
  // Hoist channel-defined agents into the id map so registry.get(id) works.
  for (const a of Object.values(byChannel)) byId[a.id] = byId[a.id] ?? a;

  const stub = {
    get: vi.fn((id: string) => byId[id]),
    getAll: vi.fn(() => Object.values(byId)),
    findByChannel: vi.fn((channel: string) => byChannel[channel]),
  };
  return stub as unknown as AgentRegistry;
}

function makeIncomingMessage(overrides: Partial<IncomingMessage> = {}): IncomingMessage {
  return {
    text: "hello agents",
    channel: "C123",
    channelName: "general",
    user: "U123",
    ts: "100.001",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests — KPR-223 simplified the adapter to a thin translator: convert
// inbound IncomingMessage → WorkItem and emit via onWorkItem. Per-turn-spawn
// branching now lives entirely inside the dispatcher.
// ---------------------------------------------------------------------------

describe("SlackAdapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("emits WorkItem via onWorkItem for inbound messages", async () => {
    const gw = makeGatewayStub();
    const registry = makeRegistryStub({
      channelAgents: { general: { id: "rae" } },
    });
    const adapter = new SlackAdapter(gw.gateway, registry, [], "slack");
    const onWorkItem = vi.fn();
    await adapter.start(onWorkItem);

    await gw.emit(makeIncomingMessage());

    expect(onWorkItem).toHaveBeenCalledTimes(1);
    const item = onWorkItem.mock.calls[0]![0] as WorkItem;
    expect(item.text).toBe("hello agents");
    expect(item.threadId).toBe("slack:C123:100.001");
    expect(item.source.kind).toBe("slack");
    expect(item.source.id).toBe("C123");
    expect(item.source.label).toBe("general");
  });

  it("propagates defaultAgentId into WorkItem.meta", async () => {
    const gw = makeGatewayStub();
    const registry = makeRegistryStub({});
    const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", "default-rae");
    const onWorkItem = vi.fn();
    await adapter.start(onWorkItem);

    await gw.emit(makeIncomingMessage());

    const item = onWorkItem.mock.calls[0]![0] as WorkItem;
    expect(item.meta?.defaultAgentId).toBe("default-rae");
  });

  it("skips messages from excluded channels", async () => {
    const gw = makeGatewayStub();
    const registry = makeRegistryStub();
    const adapter = new SlackAdapter(gw.gateway, registry, ["quo-may"], "slack");
    const onWorkItem = vi.fn();
    await adapter.start(onWorkItem);

    await gw.emit(makeIncomingMessage({ channelName: "quo-may" }));

    expect(onWorkItem).not.toHaveBeenCalled();
  });

  it("skips channels owned by agents bound to a different bot", async () => {
    const gw = makeGatewayStub();
    const registry = makeRegistryStub({
      channelAgents: { general: { id: "rae" } },
    });
    // Agent `rae` is bound to bot "other"; this adapter is bot "main".
    (registry as any).findByChannel = vi.fn(() => ({
      id: "rae",
      slackBot: "other",
    }));
    const adapter = new SlackAdapter(gw.gateway, registry, [], "slack", undefined, "main");
    const onWorkItem = vi.fn();
    await adapter.start(onWorkItem);

    await gw.emit(makeIncomingMessage());

    expect(onWorkItem).not.toHaveBeenCalled();
  });

  it("uses ts as threadId when no threadTs is set (parent message)", async () => {
    const gw = makeGatewayStub();
    const registry = makeRegistryStub();
    const adapter = new SlackAdapter(gw.gateway, registry, [], "slack");
    const onWorkItem = vi.fn();
    await adapter.start(onWorkItem);

    await gw.emit(makeIncomingMessage({ ts: "999.0" }));

    const item = onWorkItem.mock.calls[0]![0] as WorkItem;
    expect(item.threadId).toBe("slack:C123:999.0");
  });

  it("uses threadTs as threadId when set (reply)", async () => {
    const gw = makeGatewayStub();
    const registry = makeRegistryStub();
    const adapter = new SlackAdapter(gw.gateway, registry, [], "slack");
    const onWorkItem = vi.fn();
    await adapter.start(onWorkItem);

    await gw.emit(makeIncomingMessage({ ts: "888.1", threadTs: "888.0" }));

    const item = onWorkItem.mock.calls[0]![0] as WorkItem;
    expect(item.threadId).toBe("slack:C123:888.0");
  });
});
