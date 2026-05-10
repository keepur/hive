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
      { getState: vi.fn().mockReturnValue(undefined) },
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
      { getState: vi.fn().mockReturnValue(undefined) },
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
      { getState: vi.fn().mockReturnValue(state) },
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
      { getState: vi.fn().mockReturnValue(undefined) },
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
      { getState: vi.fn().mockReturnValue(undefined) },
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
      { getState: vi.fn().mockReturnValue(undefined) },
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
      { getState: vi.fn().mockReturnValue(undefined) },
    );

    const result = (adapter as any).buildAgentList();
    expect(result[0].title).toBeNull();
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
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
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
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
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
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
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
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
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
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
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
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
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
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
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
      agentManager: { getState: vi.fn().mockReturnValue(undefined) } as any,
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

// ─────────────────────────────────────────────────────────────────────
// KPR-218: per-turn-spawn path tests
// ─────────────────────────────────────────────────────────────────────

import type { TurnContext, TurnResult } from "../../agents/agent-manager.js";

interface PerTurnAgentManagerStub {
  spawnTurn: ReturnType<typeof vi.fn>;
  findAgentForThread: ReturnType<typeof vi.fn>;
  sessionStoreGet: ReturnType<typeof vi.fn>;
  sessionStoreSet: ReturnType<typeof vi.fn>;
  calls: Array<{ ctx: TurnContext }>;
  getState: ReturnType<typeof vi.fn>;
}

function makePerTurnAgentManager(turnResult: Partial<TurnResult> = {}): PerTurnAgentManagerStub {
  const calls: Array<{ ctx: TurnContext }> = [];
  const sessionStoreGet = vi.fn().mockResolvedValue(undefined as string | undefined);
  const sessionStoreSet = vi.fn().mockResolvedValue(undefined);
  const findAgentForThread = vi.fn().mockResolvedValue(undefined as string | undefined);
  const getState = vi.fn().mockReturnValue(undefined);

  const spawnTurn = vi.fn(async (ctx: TurnContext) => {
    calls.push({ ctx });
    return {
      finalMessage: "agent reply",
      newSessionId: "session-1",
      usage: {
        inputTokens: 10,
        outputTokens: 5,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        contextWindow: 200000,
        costUsd: 0.001,
        durationMs: 200,
      },
      errors: [],
      ...turnResult,
    } satisfies TurnResult;
  });

  return { spawnTurn, findAgentForThread, sessionStoreGet, sessionStoreSet, getState, calls };
}

function makePerTurnAdapterDeps(opts: {
  agents?: Record<string, { id: string; name?: string; disabled?: boolean }>;
  byOrigin?: Record<string, { id: string; disabled?: boolean }>;
  channelMembers?: string[];
  channelType?: "dm" | "channel";
  channelName?: string;
  am: PerTurnAgentManagerStub;
}) {
  const agents = opts.agents ?? {};
  const byOrigin = opts.byOrigin ?? {};
  const channelMembers = opts.channelMembers ?? ["dev1"];
  const channelType = opts.channelType ?? "channel";
  const channelName = opts.channelName ?? "general";

  const teamStore = {
    getChannel: vi.fn().mockResolvedValue({
      _id: "c1",
      type: channelType,
      name: channelName,
      members: channelMembers,
    }),
    listChannels: vi.fn().mockResolvedValue([]),
    getHistory: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    saveMessage: vi.fn().mockResolvedValue(undefined),
    getOrCreateDm: vi.fn(),
    renameChannel: vi.fn(),
    joinChannel: vi.fn(),
    leaveChannel: vi.fn(),
  } as any;
  const commandRegistry = {
    has: vi.fn().mockReturnValue(false),
    list: vi.fn().mockReturnValue([]),
    execute: vi.fn().mockResolvedValue({ found: false }),
  } as any;
  const agentRegistry = {
    get: vi.fn((id: string) => agents[id]),
    getAll: vi.fn(() => Object.values(agents)),
    findByOrigin: vi.fn((slug: string) => byOrigin[slug]),
  } as any;
  const agentManager = {
    spawnTurn: opts.am.spawnTurn as any,
    findAgentForThread: opts.am.findAgentForThread as any,
    getSessionStore: () =>
      ({
        get: opts.am.sessionStoreGet,
        set: opts.am.sessionStoreSet,
      }) as any,
    getState: opts.am.getState as any,
  } as any;
  return { teamStore, commandRegistry, agentRegistry, agentManager };
}

async function emitConnection(adapter: WsAdapter, device: any) {
  const wss = (adapter as any).wss;
  const fakeWs = new EventEmitter() as any;
  fakeWs.close = vi.fn();
  fakeWs.send = vi.fn();
  fakeWs.readyState = 1; // WebSocket.OPEN
  wss.emit("connection", fakeWs, {} as any, device);
  return fakeWs;
}

async function flush(maxMs = 200): Promise<void> {
  // Drain microtasks + a couple of macrotasks so fire-and-forget chains
  // (route → spawn → deliver) settle.
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setTimeout(r, maxMs / 20));
  }
}

async function waitFor(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}

describe("WsAdapter per-turn path (KPR-218)", () => {
  let adapter: WsAdapter | undefined;

  afterEach(async () => {
    if (adapter) {
      await adapter.stop();
      adapter = undefined;
    }
    vi.clearAllMocks();
  });

  describe("legacy path (perTurn deps absent or perTurnSpawnEnabled=false)", () => {
    it("falls back to onWorkItem when perTurn deps are not provided", async () => {
      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({
        agents: { rae: { id: "rae" } },
        am,
      });
      adapter = new WsAdapter(0, deps);
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      const fakeWs = await emitConnection(adapter, {
        _id: "dev1",
        label: "Shop",
        defaultAgentId: "",
        origin: undefined,
      });
      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
      await flush();

      expect(onWorkItem).toHaveBeenCalledTimes(1);
      expect(am.spawnTurn).not.toHaveBeenCalled();
    });

    it("falls back to onWorkItem when perTurnSpawnEnabled=false", async () => {
      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({
        agents: { rae: { id: "rae" } },
        am,
      });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: false },
      });
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      const fakeWs = await emitConnection(adapter, {
        _id: "dev1",
        label: "Shop",
        defaultAgentId: "",
      });
      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
      await flush();

      expect(onWorkItem).toHaveBeenCalledTimes(1);
      expect(am.spawnTurn).not.toHaveBeenCalled();
    });
  });

  describe("per-turn path — direct text (entry site #1)", () => {
    it("invokes spawnTurn with TurnContext shape: agentId, channelId=deviceId, threadId=app:deviceId, channel=app", async () => {
      const am = makePerTurnAgentManager({ finalMessage: "yo" });
      const deps = makePerTurnAdapterDeps({
        agents: { rae: { id: "rae", name: "Rae" } },
        am,
      });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      const onWorkItem = vi.fn();
      await adapter.start(onWorkItem);

      const fakeWs = await emitConnection(adapter, {
        _id: "dev1",
        label: "Shop",
        defaultAgentId: "",
      });
      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hello" })));

      await waitFor(() => am.spawnTurn.mock.calls.length > 0);

      expect(onWorkItem).not.toHaveBeenCalled();
      const ctx = am.calls[0]!.ctx;
      expect(ctx.agentId).toBe("rae");
      expect(ctx.channel).toBe("app");
      expect(ctx.channelId).toBe("dev1");
      expect(ctx.threadId).toBe("app:dev1");
      expect(ctx.sessionId).toBeUndefined();
      expect(ctx.workItem.text).toBe("hello");
      expect(am.sessionStoreGet).toHaveBeenCalledWith("rae", "app:dev1");
    });

    it("forwards stored sessionId so the SDK can resume on subsequent turns", async () => {
      const am = makePerTurnAgentManager();
      am.sessionStoreGet.mockResolvedValueOnce("session-resume-xyz");
      const deps = makePerTurnAdapterDeps({
        agents: { rae: { id: "rae" } },
        am,
      });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });
      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
      await waitFor(() => am.calls.length > 0);

      expect(am.calls[0]!.ctx.sessionId).toBe("session-resume-xyz");
    });
  });

  describe("per-turn path — direct image (entry site #2)", () => {
    it("invokes spawnTurn for type:image with files populated", async () => {
      const { processImageBuffer } = await import("../../files/file-processor.js");
      (processImageBuffer as any).mockResolvedValue({
        filename: "photo.jpg",
        mimetype: "image/jpeg",
        size: 4,
        kind: "image",
        content: "stub",
      });

      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({
        agents: { rae: { id: "rae" } },
        am,
      });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });
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
      await waitFor(() => am.calls.length > 0);

      const ctx = am.calls[0]!.ctx;
      expect(ctx.workItem.text).toBe("[Photo: photo.jpg]");
      expect(ctx.workItem.files).toBeDefined();
      expect(ctx.workItem.files![0]!.filename).toBe("photo.jpg");
      expect(ctx.channel).toBe("app");
    });
  });

  describe("per-turn path — team text (entry site #3)", () => {
    it("resolves DM peer via meta.targetAgentId", async () => {
      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({
        agents: { jessica: { id: "jessica" }, rae: { id: "rae" } },
        channelType: "dm",
        channelMembers: ["dev1", "jessica"],
        am,
      });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });
      fakeWs.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "message", id: "m1", channelId: "c1", text: "hi DM" })),
      );
      await waitFor(() => am.calls.length > 0);

      const ctx = am.calls[0]!.ctx;
      expect(ctx.agentId).toBe("jessica");
      expect(ctx.channel).toBe("team");
      expect(ctx.channelId).toBe("c1");
      expect(ctx.threadId).toBe("team:c1");
    });

    it("falls back to constructor defaultAgentId for non-DM team channels with no meta default", async () => {
      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({
        agents: { rae: { id: "rae" } },
        channelType: "channel",
        channelMembers: ["dev1"],
        am,
      });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      // device.defaultAgentId === "" (today's reality), so meta.defaultAgentId
      // is "" (falsy) and resolution falls through to constructor default.
      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });
      fakeWs.emit(
        "message",
        Buffer.from(JSON.stringify({ type: "message", id: "m1", channelId: "c1", text: "hello team" })),
      );
      await waitFor(() => am.calls.length > 0);

      expect(am.calls[0]!.ctx.agentId).toBe("rae");
    });
  });

  describe("per-turn path — team image (entry site #4)", () => {
    it("invokes spawnTurn for team images with DM target resolution", async () => {
      const { processImageBuffer } = await import("../../files/file-processor.js");
      (processImageBuffer as any).mockResolvedValue({
        filename: "team.jpg",
        mimetype: "image/jpeg",
        size: 4,
        kind: "image",
        content: "stub",
      });

      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({
        agents: { jessica: { id: "jessica" }, rae: { id: "rae" } },
        channelType: "dm",
        channelMembers: ["dev1", "jessica"],
        am,
      });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });
      fakeWs.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "image",
            id: "img1",
            channelId: "c1",
            filename: "team.jpg",
            data: Buffer.from("test").toString("base64"),
          }),
        ),
      );
      await waitFor(() => am.calls.length > 0);

      const ctx = am.calls[0]!.ctx;
      expect(ctx.agentId).toBe("jessica");
      expect(ctx.workItem.text).toBe("[Photo: team.jpg]");
      expect(ctx.workItem.files![0]!.filename).toBe("team.jpg");
    });
  });

  describe("per-turn path — team file (entry site #5)", () => {
    it("invokes spawnTurn for team files with DM target resolution", async () => {
      const { processFileBuffer } = await import("../../files/file-processor.js");
      (processFileBuffer as any).mockResolvedValue({
        filename: "spec.pdf",
        mimetype: "application/pdf",
        size: 10,
        kind: "doc",
        content: "stub",
      });

      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({
        agents: { jessica: { id: "jessica" }, rae: { id: "rae" } },
        channelType: "dm",
        channelMembers: ["dev1", "jessica"],
        am,
      });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });
      fakeWs.emit(
        "message",
        Buffer.from(
          JSON.stringify({
            type: "file",
            id: "f1",
            channelId: "c1",
            filename: "spec.pdf",
            mimetype: "application/pdf",
            data: Buffer.from("test").toString("base64"),
          }),
        ),
      );
      await waitFor(() => am.calls.length > 0);

      const ctx = am.calls[0]!.ctx;
      expect(ctx.agentId).toBe("jessica");
      expect(ctx.workItem.text).toBe("[File: spec.pdf]");
      expect(ctx.workItem.files![0]!.filename).toBe("spec.pdf");
    });
  });

  describe("origin routing (app-kind, dispatcher parity)", () => {
    it("routes via registry.findByOrigin when meta.origin is set", async () => {
      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({
        agents: { wyatt: { id: "wyatt" }, rae: { id: "rae" } },
        byOrigin: { "dodi-shop": { id: "wyatt" } },
        am,
      });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, {
        _id: "dev1",
        label: "Shop",
        defaultAgentId: "",
        origin: "dodi-shop",
      });
      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
      await waitFor(() => am.calls.length > 0);

      expect(am.calls[0]!.ctx.agentId).toBe("wyatt");
      expect((deps.agentRegistry as any).findByOrigin).toHaveBeenCalledWith("dodi-shop");
    });

    it("drops on origin miss (does NOT fall back to constructor default)", async () => {
      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({
        agents: { rae: { id: "rae" } },
        byOrigin: {},
        am,
      });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, {
        _id: "dev1",
        label: "Shop",
        defaultAgentId: "",
        origin: "unknown-origin",
      });
      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
      await flush();

      expect(am.spawnTurn).not.toHaveBeenCalled();
    });
  });

  describe("typing indicator", () => {
    it("sends {type:'typing'} before spawnTurn when ws is open", async () => {
      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({ agents: { rae: { id: "rae" } }, am });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      // Order observation: capture send invocations through ws.send mock and
      // assert "typing" arrives before the spawnTurn promise even resolves.
      let typingSentBeforeSpawn = false;
      am.spawnTurn.mockImplementationOnce(async (ctx: TurnContext) => {
        am.calls.push({ ctx });
        // At this point, fakeWs.send should have already been called with typing.
        const sent = (typingSpy.mock.calls as any[]).map((c) => JSON.parse(c[0]));
        typingSentBeforeSpawn = sent.some((m) => m.type === "typing" && m.agentId === "rae");
        return {
          finalMessage: "ok",
          newSessionId: "s1",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 0, costUsd: 0, durationMs: 0 },
          errors: [],
        };
      });

      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });
      const typingSpy = fakeWs.send as ReturnType<typeof vi.fn>;
      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
      await waitFor(() => am.calls.length > 0);

      expect(typingSentBeforeSpawn).toBe(true);
    });

    it("skips typing send when device socket is missing", async () => {
      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({ agents: { rae: { id: "rae" } }, am });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      // Manually push a synthetic WorkItem (no real connection) into the
      // per-turn path. The typing send must no-op (no connection in map),
      // and spawnTurn must still run + deliver buffer.
      const wi: any = {
        id: "syn",
        text: "hi",
        source: { kind: "app", id: "ghost-dev", label: "app:ghost", adapterId: "ws" },
        sender: "ghost-dev",
        senderName: "ghost",
        threadId: "app:ghost-dev",
        timestamp: new Date(),
        meta: { deviceId: "ghost-dev" },
      };
      await (adapter as any).spawnTurnForWorkItem(wi);

      expect(am.spawnTurn).toHaveBeenCalledTimes(1);
      // Buffered into pendingMessages because no connection exists.
      const pending = (adapter as any).pendingMessages as Map<string, any[]>;
      expect(pending.get("ghost-dev")?.length).toBeGreaterThan(0);
    });
  });

  describe("delivery + buffering", () => {
    it("delivers final message via deliver(); buffers when ws disconnected mid-spawn", async () => {
      const am = makePerTurnAgentManager({ finalMessage: "delivered" });
      const deps = makePerTurnAdapterDeps({ agents: { rae: { id: "rae" } }, am });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });

      // Disconnect mid-spawn: spawnTurn resolves only after we've removed
      // the connection so deliver() sees a closed socket and buffers.
      let resolveSpawn: (() => void) | undefined;
      am.spawnTurn.mockImplementationOnce(async (ctx: TurnContext) => {
        am.calls.push({ ctx });
        await new Promise<void>((r) => {
          resolveSpawn = r;
        });
        return {
          finalMessage: "delivered",
          newSessionId: "s1",
          usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreationTokens: 0, contextWindow: 0, costUsd: 0, durationMs: 0 },
          errors: [],
        };
      });

      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
      await waitFor(() => am.calls.length > 0);

      // Simulate disconnect — remove connection from map and flip state.
      (adapter as any).connections.delete("dev1");
      fakeWs.readyState = 3; // CLOSED

      resolveSpawn!();
      await flush();

      // Message landed in pendingMessages, not over the now-dead socket.
      const pending = (adapter as any).pendingMessages as Map<string, any[]>;
      const queued = pending.get("dev1") ?? [];
      const deliveredMsg = queued.find((m) => m.type === "message" && m.text === "delivered");
      expect(deliveredMsg).toBeDefined();
      expect(deliveredMsg.agentId).toBe("rae");
    });

    it("skips delivery when finalMessage is empty", async () => {
      const am = makePerTurnAgentManager({ finalMessage: "" });
      const deps = makePerTurnAdapterDeps({ agents: { rae: { id: "rae" } }, am });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });
      const sendSpy = fakeWs.send as ReturnType<typeof vi.fn>;
      sendSpy.mockClear();

      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
      await waitFor(() => am.calls.length > 0);
      await flush();

      // Only typing was sent — no delivery message.
      const sent = sendSpy.mock.calls.map((c) => JSON.parse(c[0]));
      expect(sent.some((m) => m.type === "typing")).toBe(true);
      expect(sent.some((m) => m.type === "message")).toBe(false);
    });

    it("delivers with WorkResult.error when spawnTurn returns errors[]", async () => {
      const am = makePerTurnAgentManager({
        finalMessage: "partial",
        errors: ["something went wrong"],
      });
      const deps = makePerTurnAdapterDeps({ agents: { rae: { id: "rae" } }, am });
      adapter = new WsAdapter(0, {
        ...deps,
        defaultAgentId: "rae",
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });
      const sendSpy = fakeWs.send as ReturnType<typeof vi.fn>;
      sendSpy.mockClear();

      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
      await waitFor(() => sendSpy.mock.calls.some((c) => JSON.parse(c[0]).type === "message"));

      const sent = sendSpy.mock.calls.map((c) => JSON.parse(c[0]));
      const msg = sent.find((m) => m.type === "message")!;
      expect(msg.text).toContain("something went wrong");
    });
  });

  describe("no-resolution drop path", () => {
    it("drops cleanly with no spawn when no agent resolves", async () => {
      const am = makePerTurnAgentManager();
      const deps = makePerTurnAdapterDeps({ agents: {}, am });
      adapter = new WsAdapter(0, {
        ...deps,
        // No defaultAgentId — nothing to resolve to.
        perTurn: { perTurnSpawnEnabled: true },
      });
      await adapter.start(vi.fn());

      const fakeWs = await emitConnection(adapter, { _id: "dev1", label: "Shop", defaultAgentId: "" });
      fakeWs.emit("message", Buffer.from(JSON.stringify({ type: "message", id: "m1", text: "hi" })));
      await flush();

      expect(am.spawnTurn).not.toHaveBeenCalled();
    });
  });
});
