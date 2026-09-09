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
import type { NoticeBinding, NoticeLookupGate } from "../admin/model-catalog-notification.js";
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
  postNotificationReceipt: ReturnType<typeof vi.fn>;
  resolveNotificationChannel: ReturnType<typeof vi.fn>;
  notificationChannelMatches: ReturnType<typeof vi.fn>;
  resolveUserName: ReturnType<typeof vi.fn>;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
}

function makeGatewayStub(): GatewayStub {
  let messageHandler: MessageHandler | null = null;
  const setThreadStatus = vi.fn().mockResolvedValue(undefined);
  const postMessage = vi.fn().mockResolvedValue(undefined);
  const postNotificationReceipt = vi
    .fn()
    .mockResolvedValue({ kind: "acknowledged", channelId: "CNOTICE", messageTs: "123.456" });
  const resolveNotificationChannel = vi.fn().mockResolvedValue({ channelId: "CNOTICE" });
  const notificationChannelMatches = vi.fn().mockReturnValue(true);
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
    postNotificationReceipt,
    resolveNotificationChannel,
    notificationChannelMatches,
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
    postNotificationReceipt,
    resolveNotificationChannel,
    notificationChannelMatches,
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

  it("exposes notification availability only after a successful connection", async () => {
    const gw = makeGatewayStub();
    const adapter = new SlackAdapter(gw.gateway, makeRegistryStub(), [], "slack");

    expect(adapter.notificationAvailable()).toBe(false);
    expect(adapter.notificationAvailable("named")).toBe(false);
    await adapter.start(vi.fn());
    expect(adapter.notificationAvailable()).toBe(true);
    expect(adapter.notificationAvailable("named")).toBe(false);
    expect(adapter.notificationBotLabel).toBeUndefined();
  });

  it("does not become available when gateway startup fails", async () => {
    const gw = makeGatewayStub();
    gw.start.mockRejectedValueOnce(new Error("connect failed"));
    const adapter = new SlackAdapter(gw.gateway, makeRegistryStub(), [], "slack");

    await expect(adapter.start(vi.fn())).rejects.toThrow("connect failed");
    expect(adapter.notificationAvailable()).toBe(false);
  });

  it("honors only the adapter's supported bot binding", async () => {
    const gw = makeGatewayStub();
    const adapter = new SlackAdapter(gw.gateway, makeRegistryStub(), [], "slack-main", undefined, "main");
    await adapter.start(vi.fn());

    expect(adapter.notificationBotLabel).toBe("main");
    expect(adapter.notificationAvailable()).toBe(true);
    expect(adapter.notificationAvailable("main")).toBe(true);
    expect(adapter.notificationAvailable("other")).toBe(false);
  });

  it("wraps lookup liveness with current adapter availability", async () => {
    const gw = makeGatewayStub();
    const adapter = new SlackAdapter(gw.gateway, makeRegistryStub(), [], "slack");
    await adapter.start(vi.fn());
    const outer = { check: vi.fn().mockResolvedValue(true), current: vi.fn(() => true) };
    gw.resolveNotificationChannel.mockImplementationOnce(async (_homeBase: string, gate: NoticeLookupGate) => {
      expect(await gate.check()).toBe(true);
      expect(gate.current()).toBe(true);
      return { channelId: "CNOTICE" };
    });

    await expect(adapter.resolveNotificationChannel("catalog-notices", outer)).resolves.toEqual({
      channelId: "CNOTICE",
    });
    expect(gw.resolveNotificationChannel).toHaveBeenCalledTimes(1);
    expect(outer.check).toHaveBeenCalledTimes(1);
    expect(outer.current).toHaveBeenCalledTimes(1);

    await adapter.stop();
    await expect(adapter.resolveNotificationChannel("catalog-notices", outer)).resolves.toEqual({ channelId: null });
    expect(gw.resolveNotificationChannel).toHaveBeenCalledTimes(1);
  });

  it("clears notification availability synchronously before gateway teardown", async () => {
    const gw = makeGatewayStub();
    let release!: () => void;
    gw.stop.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const adapter = new SlackAdapter(gw.gateway, makeRegistryStub(), [], "slack");
    await adapter.start(vi.fn());

    const stopping = adapter.stop();
    expect(adapter.notificationAvailable()).toBe(false);
    release();
    await stopping;
  });

  it("validates the frozen route before using the receipt path", async () => {
    const gw = makeGatewayStub();
    const adapter = new SlackAdapter(gw.gateway, makeRegistryStub(), [], "slack");
    const route: NoticeBinding = {
      agentId: "chief-of-staff",
      homeBase: "catalog-notices",
      adapterId: "slack",
      channelId: "CNOTICE",
    };
    await adapter.start(vi.fn());

    expect(adapter.notificationRouteMatches(route)).toBe(true);
    expect(gw.notificationChannelMatches).toHaveBeenCalledWith("catalog-notices", "CNOTICE");
    await expect(adapter.deliverNotificationReceipt(route, "catalog changed")).resolves.toEqual({
      kind: "acknowledged",
      channelId: "CNOTICE",
      messageTs: "123.456",
    });
    expect(gw.postNotificationReceipt).toHaveBeenCalledWith("CNOTICE", "catalog changed");

    gw.notificationChannelMatches.mockReturnValueOnce(false);
    await expect(adapter.deliverNotificationReceipt(route, "stale route")).resolves.toEqual({
      kind: "not-accepted",
      reason: "transport-unavailable",
    });
    expect(gw.postNotificationReceipt).toHaveBeenCalledTimes(1);
  });

  it("rejects the primary adapter for an explicit bot route without posting", async () => {
    const gw = makeGatewayStub();
    const adapter = new SlackAdapter(gw.gateway, makeRegistryStub(), [], "slack");
    await adapter.start(vi.fn());
    const route: NoticeBinding = {
      agentId: "chief-of-staff",
      homeBase: "CNOTICE",
      adapterId: "slack",
      channelId: "CNOTICE",
      botLabel: "named",
    };

    expect(adapter.notificationRouteMatches(route)).toBe(false);
    await expect(adapter.deliverNotificationReceipt(route, "catalog changed")).resolves.toEqual({
      kind: "not-accepted",
      reason: "transport-unavailable",
    });
    expect(gw.postNotificationReceipt).not.toHaveBeenCalled();
  });
});
