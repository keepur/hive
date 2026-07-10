import { describe, it, expect, vi, afterEach } from "vitest";
import { WsAdapter } from "./ws-adapter.js";
import { EventEmitter } from "node:events";
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
    model: "claude-haiku-4-5",
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

/**
 * Minimal noop team deps — the existing upgrade/auth/origin tests don't
 * exercise team command paths, but WsAdapterDeps now requires them (KPR-11).
 */
function noopTeamDeps() {
  return {
    teamStore: {
      getChannel: vi.fn().mockResolvedValue(null),
      listChannels: vi.fn().mockResolvedValue([]),
      getHistory: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
      saveMessage: vi.fn().mockResolvedValue(undefined),
      getOrCreateDm: vi.fn(),
      renameChannel: vi.fn(),
      joinChannel: vi.fn(),
      leaveChannel: vi.fn(),
    } as any,
    commandRegistry: {
      has: vi.fn().mockReturnValue(false),
      list: vi.fn().mockReturnValue([]),
      execute: vi.fn().mockResolvedValue({ found: false }),
    } as any,
  };
}

function makeAdapter(agentRegistry: any, agentManager: any) {
  return new WsAdapter(3200, { ...noopTeamDeps(), agentRegistry, agentManager });
}

describe("WsAdapter.buildAgentList()", () => {
  it("returns empty array when registry has no agents", () => {
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([]) },
      { getState: vi.fn().mockReturnValue(undefined), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );

    const result = (adapter as any).buildAgentList();
    expect(result).toEqual([]);
  });

  it("maps agent config fields correctly", () => {
    const agent = makeAgent({
      id: "rae",
      name: "Rae",
      icon: ":wave:",
      title: "Receptionist",
      model: "claude-haiku-4-5",
      channels: ["general", "support"],
    });

    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([agent]) },
      { getState: vi.fn().mockReturnValue(undefined), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );

    const result = (adapter as any).buildAgentList();
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("rae");
    expect(result[0].name).toBe("Rae");
    expect(result[0].icon).toBe(":wave:");
    expect(result[0].title).toBe("Receptionist");
    expect(result[0].model).toBe("claude-haiku-4-5");
    expect(result[0].channels).toEqual(["general", "support"]);
  });

  it("merges runtime state when available", () => {
    const agent = makeAgent({ id: "jasper" });
    const state: Partial<AgentState> = {
      status: "processing",
      messagesProcessed: 42,
      lastActivity: new Date("2026-04-12T10:00:00.000Z"),
    };

    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([agent]) },
      { getState: vi.fn().mockReturnValue(state), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );

    const result = (adapter as any).buildAgentList();
    expect(result[0].status).toBe("processing");
    expect(result[0].messagesProcessed).toBe(42);
    expect(result[0].lastActivity).toBe("2026-04-12T10:00:00.000Z");
  });

  it("uses defaults when agent has no runtime state", () => {
    const agent = makeAgent({ id: "milo" });

    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([agent]) },
      { getState: vi.fn().mockReturnValue(undefined), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
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

    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([agent]) },
      { getState: vi.fn().mockReturnValue(undefined), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
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

    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([agent]) },
      { getState: vi.fn().mockReturnValue(undefined), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );

    const result = (adapter as any).buildAgentList();
    expect(result[0].schedule).toEqual([
      { cron: "0 9 * * 1-5", task: "Send morning digest" },
      { cron: "0 0 * * *", task: "Nightly cleanup" },
    ]);
  });

  it("maps title to null when undefined", () => {
    const agent = makeAgent({ title: undefined });

    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([agent]) },
      { getState: vi.fn().mockReturnValue(undefined), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );

    const result = (adapter as any).buildAgentList();
    expect(result[0].title).toBeNull();
  });

  it("exposes floorCritical, defaulting false", () => {
    const flagged = makeAgent({ id: "floor", floorCritical: true });
    const plain = makeAgent({ id: "plain" });
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([flagged, plain]) },
      { getState: vi.fn().mockReturnValue(undefined), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );
    const result = (adapter as any).buildAgentList();
    expect(result.find((a: any) => a.id === "floor").floorCritical).toBe(true);
    expect(result.find((a: any) => a.id === "plain").floorCritical).toBe(false);
  });
});

describe("WsAdapter upgrade handler", () => {
  let adapter: WsAdapter | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = undefined;
    }
  });

  function makeFakeSocket(remoteAddress: string) {
    const socket = new EventEmitter() as EventEmitter & {
      remoteAddress: string;
      writtenChunks: string[];
      destroyed: boolean;
      write: (chunk: string) => void;
      destroy: () => void;
    };
    socket.remoteAddress = remoteAddress;
    socket.writtenChunks = [];
    socket.destroyed = false;
    socket.write = (chunk: string) => {
      socket.writtenChunks.push(chunk);
    };
    socket.destroy = () => {
      socket.destroyed = true;
    };
    return socket;
  }

  async function startAdapter() {
    adapter = new WsAdapter(0, {
      ...noopTeamDeps(),
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    });
    await adapter.start(() => {});
    return adapter;
  }

  function getUpgradeListener(a: WsAdapter): (req: any, socket: any, head: Buffer) => void {
    const server = (a as any).server;
    const listeners = server.listeners("upgrade");
    return listeners[listeners.length - 1];
  }

  it("accepts internal=1 from ::ffff:127.0.0.1 and surfaces deviceId/label", async () => {
    const a = await startAdapter();

    // Capture the emitted connection so we can inspect the synthetic Device.
    const wss = (a as any).wss;
    const handleUpgradeSpy = vi.spyOn(wss, "handleUpgrade").mockImplementation(((
      _req: any,
      _socket: any,
      _head: any,
      cb: any,
    ) => {
      const fakeWs = new EventEmitter() as any;
      fakeWs.close = vi.fn();
      fakeWs.send = vi.fn();
      cb(fakeWs);
    }) as any);

    const emittedDevices: any[] = [];
    wss.on("connection", (_ws: any, _req: any, device: any) => {
      emittedDevices.push(device);
    });

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?internal=1&deviceId=bk-abc&label=beekeeper",
      headers: {},
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };
    const socket = makeFakeSocket("::ffff:127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(handleUpgradeSpy).toHaveBeenCalledTimes(1);
    expect(socket.destroyed).toBe(false);
    expect(emittedDevices).toHaveLength(1);
    expect(emittedDevices[0]._id).toBe("bk-abc");
    expect(emittedDevices[0].label).toBe("beekeeper");
    expect(emittedDevices[0].user).toBeUndefined();
    expect(emittedDevices[0].defaultAgentId).toBe("");
  });

  it("accepts transitional ?name= fallback when ?label= is absent", async () => {
    const a = await startAdapter();

    const wss = (a as any).wss;
    vi.spyOn(wss, "handleUpgrade").mockImplementation(((_req: any, _socket: any, _head: any, cb: any) => {
      const fakeWs = new EventEmitter() as any;
      fakeWs.close = vi.fn();
      fakeWs.send = vi.fn();
      cb(fakeWs);
    }) as any);

    const emittedDevices: any[] = [];
    wss.on("connection", (_ws: any, _req: any, device: any) => {
      emittedDevices.push(device);
    });

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?internal=1&deviceId=bk-abc&name=beekeeper",
      headers: {},
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };
    const socket = makeFakeSocket("::ffff:127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(socket.destroyed).toBe(false);
    expect(emittedDevices).toHaveLength(1);
    expect(emittedDevices[0].label).toBe("beekeeper");
  });

  it("surfaces server-asserted ?user= on the synthetic Device", async () => {
    const a = await startAdapter();

    const wss = (a as any).wss;
    vi.spyOn(wss, "handleUpgrade").mockImplementation(((_req: any, _socket: any, _head: any, cb: any) => {
      const fakeWs = new EventEmitter() as any;
      fakeWs.close = vi.fn();
      fakeWs.send = vi.fn();
      cb(fakeWs);
    }) as any);

    const emittedDevices: any[] = [];
    wss.on("connection", (_ws: any, _req: any, device: any) => {
      emittedDevices.push(device);
    });

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?internal=1&deviceId=dev1&label=Shop&user=may-keepur",
      headers: {},
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };
    const socket = makeFakeSocket("::ffff:127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(emittedDevices).toHaveLength(1);
    expect(emittedDevices[0].user).toBe("may-keepur");
  });

  it("rejects upgrade with deviceId but no label or name with 400", async () => {
    const a = await startAdapter();

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?internal=1&deviceId=bk-abc",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    };
    const socket = makeFakeSocket("127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(socket.destroyed).toBe(true);
    expect(socket.writtenChunks.join("")).toContain("400 Bad Request");
  });

  it("rejects internal=1 from non-loopback with 403", async () => {
    const a = await startAdapter();

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?internal=1&deviceId=bk-abc&label=beekeeper",
      headers: {},
      socket: { remoteAddress: "203.0.113.7" },
    };
    const socket = makeFakeSocket("203.0.113.7");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(socket.destroyed).toBe(true);
    expect(socket.writtenChunks.join("")).toContain("403 Forbidden");
  });

  it("upgrade with ?origin=dodi-shop surfaces origin on synthetic Device", async () => {
    const a = await startAdapter();

    const wss = (a as any).wss;
    vi.spyOn(wss, "handleUpgrade").mockImplementation(((_req: any, _socket: any, _head: any, cb: any) => {
      const fakeWs = new EventEmitter() as any;
      fakeWs.close = vi.fn();
      fakeWs.send = vi.fn();
      cb(fakeWs);
    }) as any);

    const emittedDevices: any[] = [];
    wss.on("connection", (_ws: any, _req: any, device: any) => {
      emittedDevices.push(device);
    });

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?internal=1&deviceId=dev1&label=Shop&origin=dodi-shop",
      headers: {},
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };
    const socket = makeFakeSocket("::ffff:127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(emittedDevices).toHaveLength(1);
    expect(emittedDevices[0]._id).toBe("dev1");
    expect(emittedDevices[0].origin).toBe("dodi-shop");
  });

  it("upgrade without origin leaves device.origin undefined", async () => {
    const a = await startAdapter();

    const wss = (a as any).wss;
    vi.spyOn(wss, "handleUpgrade").mockImplementation(((_req: any, _socket: any, _head: any, cb: any) => {
      const fakeWs = new EventEmitter() as any;
      fakeWs.close = vi.fn();
      fakeWs.send = vi.fn();
      cb(fakeWs);
    }) as any);

    const emittedDevices: any[] = [];
    wss.on("connection", (_ws: any, _req: any, device: any) => {
      emittedDevices.push(device);
    });

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?internal=1&deviceId=dev1&label=Shop",
      headers: {},
      socket: { remoteAddress: "::ffff:127.0.0.1" },
    };
    const socket = makeFakeSocket("::ffff:127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(emittedDevices[0].origin).toBeUndefined();
  });

  it("emits WorkItem with meta.origin='dodi-shop' on type:message", async () => {
    adapter = new WsAdapter(0, {
      ...noopTeamDeps(),
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    });
    const captured: any[] = [];
    await adapter.start((item) => captured.push(item));

    const wss = (adapter as any).wss;
    const fakeWs = new EventEmitter() as any;
    fakeWs.close = vi.fn();
    fakeWs.send = vi.fn();
    const device = { _id: "dev1", label: "Shop", defaultAgentId: "", origin: "dodi-shop" };
    wss.emit("connection", fakeWs, {} as any, device);

    fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
    // allow microtasks to flush the async message handler
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].id).toBe("m1");
    expect(captured[0].text).toBe("hi");
    expect(captured[0].source.kind).toBe("app");
    expect(captured[0].meta?.origin).toBe("dodi-shop");
  });

  it("emits WorkItem with meta.origin='dodi-shop' on type:image", async () => {
    const { processImageBuffer } = await import("../../files/file-processor.js");
    (processImageBuffer as any).mockResolvedValue({
      filename: "photo.jpg",
      mimetype: "image/jpeg",
      size: 4,
      kind: "image",
      content: "stub",
    });

    adapter = new WsAdapter(0, {
      ...noopTeamDeps(),
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    });
    const captured: any[] = [];
    await adapter.start((item) => captured.push(item));

    const wss = (adapter as any).wss;
    const fakeWs = new EventEmitter() as any;
    fakeWs.close = vi.fn();
    fakeWs.send = vi.fn();
    const device = { _id: "dev1", label: "Shop", defaultAgentId: "", origin: "dodi-shop" };
    wss.emit("connection", fakeWs, {} as any, device);

    fakeWs.emit(
      "message",
      Buffer.from(
        JSON.stringify({
          type: "image",
          id: "img1",
          filename: "photo.jpg",
          data: Buffer.from("test").toString("base64"),
        }),
      ),
    );
    // allow async image processing + onWorkItem
    await new Promise((r) => setTimeout(r, 10));

    expect(captured).toHaveLength(1);
    expect(captured[0].id).toBe("img1");
    expect(captured[0].source.kind).toBe("app");
    expect(captured[0].meta?.origin).toBe("dodi-shop");
  });

  it("rejects upgrade without ?internal=1 with 404", async () => {
    const a = await startAdapter();

    const upgrade = getUpgradeListener(a);
    const req: any = {
      url: "/?token=anything",
      headers: {},
      socket: { remoteAddress: "127.0.0.1" },
    };
    const socket = makeFakeSocket("127.0.0.1");
    await upgrade(req, socket, Buffer.alloc(0));

    expect(socket.destroyed).toBe(true);
    expect(socket.writtenChunks.join("")).toContain("404 Not Found");
  });
});

describe("WsAdapter team meta.user propagation (KPR-23)", () => {
  let adapter: WsAdapter | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = undefined;
    }
  });

  it("puts device.user on WorkItem.meta.user for team messages", async () => {
    const teamDeps = noopTeamDeps();
    (teamDeps.teamStore.getChannel as any).mockResolvedValue({
      _id: "c1",
      type: "channel",
      name: "general",
      members: ["dev1"],
    });

    adapter = new WsAdapter(0, {
      ...teamDeps,
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    });

    const captured: any[] = [];
    await adapter.start((item) => captured.push(item));

    const device = { _id: "dev1", label: "Shop", user: "may-keepur", defaultAgentId: "", origin: undefined };
    const wss = (adapter as any).wss;
    const fakeWs = new EventEmitter() as any;
    fakeWs.close = vi.fn();
    fakeWs.send = vi.fn();
    wss.emit("connection", fakeWs, {} as any, device);

    fakeWs.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "message", id: "m1", channelId: "c1", text: "hi team" })),
    );
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].meta?.user).toBe("may-keepur");
    expect(captured[0].meta?.channelId).toBe("c1");
  });

  it("omits meta.user when device.user is undefined (transitional beekeeper)", async () => {
    const teamDeps = noopTeamDeps();
    (teamDeps.teamStore.getChannel as any).mockResolvedValue({
      _id: "c1",
      type: "channel",
      name: "general",
      members: ["dev1"],
    });

    adapter = new WsAdapter(0, {
      ...teamDeps,
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    });

    const captured: any[] = [];
    await adapter.start((item) => captured.push(item));

    const device = { _id: "dev1", label: "Shop", user: undefined, defaultAgentId: "", origin: undefined };
    const wss = (adapter as any).wss;
    const fakeWs = new EventEmitter() as any;
    fakeWs.close = vi.fn();
    fakeWs.send = vi.fn();
    wss.emit("connection", fakeWs, {} as any, device);

    fakeWs.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "message", id: "m1", channelId: "c1", text: "hi team" })),
    );
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].meta?.user).toBeUndefined();
  });

  it("ignores client-supplied `user` inside forwarded frames", async () => {
    const teamDeps = noopTeamDeps();
    (teamDeps.teamStore.getChannel as any).mockResolvedValue({
      _id: "c1",
      type: "channel",
      name: "general",
      members: ["dev1"],
    });

    adapter = new WsAdapter(0, {
      ...teamDeps,
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    });

    const captured: any[] = [];
    await adapter.start((item) => captured.push(item));

    const device = { _id: "dev1", label: "Shop", user: "may-keepur", defaultAgentId: "", origin: undefined };
    const wss = (adapter as any).wss;
    const fakeWs = new EventEmitter() as any;
    fakeWs.close = vi.fn();
    fakeWs.send = vi.fn();
    wss.emit("connection", fakeWs, {} as any, device);

    // Frame carries a rogue `user` field — must be dropped.
    fakeWs.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "message", id: "m1", channelId: "c1", text: "hi", user: "attacker" })),
    );
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].meta?.user).toBe("may-keepur");
  });

  it("never promotes a frame-level `user` when device.user is undefined", async () => {
    // Hardening case: if the URL-asserted identity is absent (transitional
    // beekeeper), a rogue frame-level `user` field MUST NOT be used as a
    // fallback. The only trusted source is the URL query param.
    const teamDeps = noopTeamDeps();
    (teamDeps.teamStore.getChannel as any).mockResolvedValue({
      _id: "c1",
      type: "channel",
      name: "general",
      members: ["dev1"],
    });

    adapter = new WsAdapter(0, {
      ...teamDeps,
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    });

    const captured: any[] = [];
    await adapter.start((item) => captured.push(item));

    const device = { _id: "dev1", label: "Shop", user: undefined, defaultAgentId: "", origin: undefined };
    const wss = (adapter as any).wss;
    const fakeWs = new EventEmitter() as any;
    fakeWs.close = vi.fn();
    fakeWs.send = vi.fn();
    wss.emit("connection", fakeWs, {} as any, device);

    fakeWs.emit(
      "message",
      Buffer.from(JSON.stringify({ type: "message", id: "m1", channelId: "c1", text: "hi", user: "attacker" })),
    );
    await new Promise((r) => setImmediate(r));

    expect(captured).toHaveLength(1);
    expect(captured[0].meta?.user).toBeUndefined();
  });
});

describe("WsAdapter.handleCommand (KPR-11)", () => {
  const fakeDevice = { _id: "dev1", label: "Shopper", defaultAgentId: "" };

  function makeFakeWs() {
    const sent: any[] = [];
    return {
      sent,
      ws: {
        readyState: 1, // WebSocket.OPEN
        send: (data: string) => sent.push(JSON.parse(data)),
      } as any,
    };
  }

  function makeAdapterWithCommandDeps(overrides: {
    registryHas: (name: string) => boolean;
    execute?: (name: string, ctx: any) => Promise<{ found: boolean; result?: string }>;
    saveMessage?: (msg: any) => Promise<void>;
  }) {
    const saveMessage = overrides.saveMessage ?? vi.fn().mockResolvedValue(undefined);
    const execute = overrides.execute ?? vi.fn().mockResolvedValue({ found: true, result: "ok" });
    const deps = {
      teamStore: {
        getChannel: vi.fn().mockResolvedValue(null),
        listChannels: vi.fn().mockResolvedValue([]),
        getHistory: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
        saveMessage,
        getOrCreateDm: vi.fn(),
        renameChannel: vi.fn(),
        joinChannel: vi.fn(),
        leaveChannel: vi.fn(),
      } as any,
      commandRegistry: {
        has: vi.fn((name: string) => overrides.registryHas(name)),
        list: vi.fn().mockReturnValue([]),
        execute,
      } as any,
      agentRegistry: { getAll: vi.fn().mockReturnValue([]) } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    };
    const adapter = new WsAdapter(0, deps);
    return { adapter, deps, saveMessage, execute };
  }

  it("unknown command acks once and returns explicit error without saving", async () => {
    const { adapter, deps, saveMessage, execute } = makeAdapterWithCommandDeps({
      registryHas: () => false,
    });
    const { ws, sent } = makeFakeWs();
    const msg = { type: "command" as const, channelId: "c1", name: "nonexistent", args: [], id: "m1" };

    await (adapter as any).handleCommand(ws, msg, fakeDevice, fakeDevice._id);

    // Single ack, single error, nothing else
    const acks = sent.filter((m) => m.type === "ack");
    const errors = sent.filter((m) => m.type === "error");
    expect(acks).toHaveLength(1);
    expect(acks[0]).toEqual({ type: "ack", id: "m1" });
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toBe("Unknown command: /nonexistent");
    // No fallthrough to execute or save
    expect(execute).not.toHaveBeenCalled();
    expect(saveMessage).not.toHaveBeenCalled();
    // has() was consulted
    expect(deps.commandRegistry.has).toHaveBeenCalledWith("nonexistent");
  });

  it("known command acks once, executes, saves result, and replies", async () => {
    const { adapter, saveMessage, execute } = makeAdapterWithCommandDeps({
      registryHas: () => true,
      execute: vi.fn().mockResolvedValue({ found: true, result: "DM ready: dm:a:b" }),
    });
    const { ws, sent } = makeFakeWs();
    const msg = { type: "command" as const, channelId: "c1", name: "dm", args: ["jessica"], id: "m2" };

    await (adapter as any).handleCommand(ws, msg, fakeDevice, fakeDevice._id);

    expect(sent.filter((m) => m.type === "ack")).toHaveLength(1);
    expect(execute).toHaveBeenCalledWith("dm", {
      channelId: "c1",
      senderId: fakeDevice._id,
      senderName: fakeDevice.label,
      args: ["jessica"],
    });
    expect(saveMessage).toHaveBeenCalledTimes(1);
    const replies = sent.filter((m) => m.type === "message");
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe("DM ready: dm:a:b");
    expect(replies[0].replyTo).toBe("m2");
  });

  it("known command with empty result does NOT save a system message", async () => {
    const { adapter, saveMessage } = makeAdapterWithCommandDeps({
      registryHas: () => true,
      execute: vi.fn().mockResolvedValue({ found: true, result: undefined }),
    });
    const { ws, sent } = makeFakeWs();
    const msg = { type: "command" as const, channelId: "c1", name: "help", args: [], id: "m3" };

    await (adapter as any).handleCommand(ws, msg, fakeDevice, fakeDevice._id);

    // Ack + reply go out, but no save-as-system-message
    expect(sent.filter((m) => m.type === "ack")).toHaveLength(1);
    expect(saveMessage).not.toHaveBeenCalled();
    const replies = sent.filter((m) => m.type === "message");
    expect(replies).toHaveLength(1);
    expect(replies[0].text).toBe("Done.");
  });
});

describe("WsAdapter buffering on disconnect (KPR-223 coverage migration)", () => {
  // Re-asserts the per-channel-adapter outbound buffer/drain that the deleted
  // KPR-218 integration test used to incidentally cover. Tests target the
  // buffering logic (ws-adapter.ts:63 pendingMessages, lines 176-183 drain on
  // connect, lines 388-391 enqueue on disconnect) — NOT per-turn round-trip
  // or session rotation (gone with KPR-218 and not coming back).
  let adapter: WsAdapter | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = undefined;
    }
  });

  function makeWorkResult(deviceId: string, agentId = "rae", text = "buffered hello") {
    return {
      text,
      agentId,
      workItem: {
        id: "w1",
        text: "ping",
        source: { kind: "app" as const, id: deviceId, label: `app:${deviceId}`, adapterId: "ws" },
        sender: deviceId,
        threadId: `app:${deviceId}`,
        timestamp: new Date(),
        meta: { deviceId },
      },
      costUsd: 0,
      durationMs: 1,
    };
  }

  it("buffers an outbound message when device is not connected", async () => {
    adapter = new WsAdapter(0, {
      ...noopTeamDeps(),
      agentRegistry: {
        getAll: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue({ name: "Rae" }),
      } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    });
    await adapter.start(() => {});

    // Deliver to a deviceId that has NO active connection.
    await adapter.deliver(makeWorkResult("ghost-device") as any);

    // Peek into pendingMessages to confirm enqueue (cast to any — private field).
    const pending = (adapter as any).pendingMessages as Map<string, any[]>;
    expect(pending.has("ghost-device")).toBe(true);
    const queue = pending.get("ghost-device")!;
    expect(queue).toHaveLength(1);
    expect(queue[0].type).toBe("message");
    expect(queue[0].text).toBe("buffered hello");
    expect(queue[0].agentId).toBe("rae");
  });

  it("drains pending messages when device reconnects", async () => {
    adapter = new WsAdapter(0, {
      ...noopTeamDeps(),
      agentRegistry: {
        getAll: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue({ name: "Rae" }),
      } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    });
    await adapter.start(() => {});

    // 1. Deliver to disconnected device → enqueues in pendingMessages.
    await adapter.deliver(makeWorkResult("dev-reconnect", "rae", "first") as any);
    await adapter.deliver(makeWorkResult("dev-reconnect", "rae", "second") as any);

    const pending = (adapter as any).pendingMessages as Map<string, any[]>;
    expect(pending.get("dev-reconnect")).toHaveLength(2);

    // 2. Simulate WS reconnect — emit `connection` event with same deviceId.
    const wss = (adapter as any).wss;
    const sent: any[] = [];
    const fakeWs = new EventEmitter() as any;
    fakeWs.readyState = 1; // WebSocket.OPEN
    fakeWs.send = (data: string) => sent.push(JSON.parse(data));
    fakeWs.close = vi.fn();
    const device = { _id: "dev-reconnect", label: "Reconnecting", defaultAgentId: "" };
    wss.emit("connection", fakeWs, {} as any, device);

    // 3. Pending queue is drained over the new connection in FIFO order, and
    //    the entry is removed from the map.
    expect(sent).toHaveLength(2);
    expect(sent[0].text).toBe("first");
    expect(sent[1].text).toBe("second");
    expect(pending.has("dev-reconnect")).toBe(false);
  });

  it("does not drain or throw on reconnect when the pending queue is empty", async () => {
    adapter = new WsAdapter(0, {
      ...noopTeamDeps(),
      agentRegistry: {
        getAll: vi.fn().mockReturnValue([]),
        get: vi.fn().mockReturnValue({ name: "Rae" }),
      } as any,
      agentManager: {
        getState: vi.fn().mockReturnValue(undefined),
        getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }),
      } as any,
    });
    await adapter.start(() => {});

    const wss = (adapter as any).wss;
    const sent: any[] = [];
    const fakeWs = new EventEmitter() as any;
    fakeWs.readyState = 1;
    fakeWs.send = (data: string) => sent.push(JSON.parse(data));
    fakeWs.close = vi.fn();
    const device = { _id: "fresh-device", label: "Fresh", defaultAgentId: "" };

    // Should not throw, no spurious sends.
    expect(() => wss.emit("connection", fakeWs, {} as any, device)).not.toThrow();
    expect(sent).toHaveLength(0);
    const pending = (adapter as any).pendingMessages as Map<string, any[]>;
    expect(pending.has("fresh-device")).toBe(false);
  });
});

describe("WsAdapter.deliverBroadcast (KPR-308)", () => {
  function makeResult(overrides: Record<string, any> = {}) {
    return {
      text: "outage update",
      agentId: "floor-agent",
      workItem: {
        id: "sched-1",
        text: "[Scheduled task]",
        source: { kind: "slack", id: "agent-floor", label: "agent-floor" },
        sender: "system",
        timestamp: new Date(),
        meta: { targetAgentId: "floor-agent" },
      },
      costUsd: 0,
      durationMs: 0,
      ...overrides,
    } as any;
  }

  function fakeSocket(readyState: number) {
    return { readyState, send: vi.fn() } as any;
  }

  it("sends the standard message frame to every open connection and returns the count", async () => {
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue({ name: "Floor Agent" }) },
      { getState: vi.fn(), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );
    const wsA = fakeSocket(1); // WebSocket.OPEN
    const wsB = fakeSocket(1);
    (adapter as any).connections.set("dev-a", wsA);
    (adapter as any).connections.set("dev-b", wsB);

    const count = await adapter.deliverBroadcast(makeResult());

    expect(count).toBe(2);
    for (const ws of [wsA, wsB]) {
      expect(ws.send).toHaveBeenCalledTimes(1);
      const frame = JSON.parse(ws.send.mock.calls[0][0]);
      expect(frame).toMatchObject({
        type: "message",
        text: "outage update",
        agentId: "floor-agent",
        agentName: "Floor Agent",
        replyTo: "sched-1",
      });
    }
  });

  it("skips non-open sockets and does not count them", async () => {
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(undefined) },
      { getState: vi.fn(), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );
    const open = fakeSocket(1);
    const closed = fakeSocket(3); // WebSocket.CLOSED
    (adapter as any).connections.set("dev-open", open);
    (adapter as any).connections.set("dev-closed", closed);

    const count = await adapter.deliverBroadcast(makeResult());

    expect(count).toBe(1);
    expect(open.send).toHaveBeenCalledTimes(1);
    expect(closed.send).not.toHaveBeenCalled();
  });

  it("returns 0 with no connections and never touches pendingMessages", async () => {
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(undefined) },
      { getState: vi.fn(), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );

    const count = await adapter.deliverBroadcast(makeResult());

    expect(count).toBe(0);
    expect((adapter as any).pendingMessages.size).toBe(0);
  });

  it("falls back to agent id when the agent is missing from the registry", async () => {
    const adapter = makeAdapter(
      { getAll: vi.fn().mockReturnValue([]), get: vi.fn().mockReturnValue(undefined) },
      { getState: vi.fn(), getSnapshot: vi.fn().mockReturnValue({ perAgent: {} }) },
    );
    const ws = fakeSocket(1);
    (adapter as any).connections.set("dev-a", ws);

    await adapter.deliverBroadcast(makeResult());

    expect(JSON.parse(ws.send.mock.calls[0][0]).agentName).toBe("floor-agent");
  });
});
