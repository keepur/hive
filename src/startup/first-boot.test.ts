import { describe, it, expect, vi, beforeEach } from "vitest";
import { checkFirstBoot } from "./first-boot.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { Dispatcher } from "../channels/dispatcher.js";

function mockMemoryManager(flagValue: string | null, throwOnRead = false, throwOnWrite = false) {
  return {
    read: vi.fn().mockImplementation(async () => {
      if (throwOnRead) throw new Error("MongoDB read error");
      return flagValue;
    }),
    write: vi.fn().mockImplementation(async () => {
      if (throwOnWrite) throw new Error("MongoDB write error");
    }),
  } as unknown as MemoryManager;
}

function mockRegistry(homeBase?: string, channels?: string[]) {
  return {
    get: vi
      .fn()
      .mockReturnValue(
        homeBase || channels ? { _id: "chief-of-staff", homeBase, channels: channels ?? [] } : undefined,
      ),
  } as unknown as AgentRegistry;
}

function mockDispatcher() {
  return {
    dispatch: vi.fn().mockResolvedValue(undefined),
  } as unknown as Dispatcher;
}

const channelMap = new Map([["agent-chief", "C12345"]]);
const emptyChannelMap = new Map<string, string>();

describe("checkFirstBoot", () => {
  it("dispatches greeting when flag is not set", async () => {
    const mem = mockMemoryManager(null);
    const reg = mockRegistry(undefined, ["agent-chief"]);
    const disp = mockDispatcher();

    await checkFirstBoot(mem, reg, disp, channelMap);

    expect(mem.write).toHaveBeenCalledWith("hive/first-boot-greeting-sent", expect.any(String), "system");
    expect(disp.dispatch).toHaveBeenCalledTimes(1);
    const workItem = (disp.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(workItem.meta.targetAgentId).toBe("chief-of-staff");
    expect(workItem.meta.systemTrigger).toBe("first-boot");
    expect(workItem.sender).toBe("system");
    expect(workItem.source.id).toBe("C12345");
  });

  it("skips when flag is already set", async () => {
    const mem = mockMemoryManager("true");
    const reg = mockRegistry(undefined, ["agent-chief"]);
    const disp = mockDispatcher();

    await checkFirstBoot(mem, reg, disp, channelMap);

    expect(mem.write).not.toHaveBeenCalled();
    expect(disp.dispatch).not.toHaveBeenCalled();
  });

  it("skips when MongoDB read fails", async () => {
    const mem = mockMemoryManager(null, true);
    const reg = mockRegistry(undefined, ["agent-chief"]);
    const disp = mockDispatcher();

    await checkFirstBoot(mem, reg, disp, channelMap);

    expect(mem.write).not.toHaveBeenCalled();
    expect(disp.dispatch).not.toHaveBeenCalled();
  });

  it("skips when CoS has no channels", async () => {
    const mem = mockMemoryManager(null);
    const reg = mockRegistry(undefined, []);
    const disp = mockDispatcher();

    await checkFirstBoot(mem, reg, disp, channelMap);

    expect(disp.dispatch).not.toHaveBeenCalled();
    expect(mem.write).not.toHaveBeenCalled();
  });

  it("skips when channel ID cannot be resolved", async () => {
    const mem = mockMemoryManager(null);
    const reg = mockRegistry(undefined, ["agent-chief"]);
    const disp = mockDispatcher();

    await checkFirstBoot(mem, reg, disp, emptyChannelMap);

    expect(disp.dispatch).not.toHaveBeenCalled();
    expect(mem.write).not.toHaveBeenCalled();
  });

  it("aborts dispatch when flag write fails", async () => {
    const mem = mockMemoryManager(null, false, true);
    const reg = mockRegistry(undefined, ["agent-chief"]);
    const disp = mockDispatcher();

    await checkFirstBoot(mem, reg, disp, channelMap);

    expect(disp.dispatch).not.toHaveBeenCalled();
  });

  it("prefers homeBase over channels[0]", async () => {
    const mem = mockMemoryManager(null);
    const reg = mockRegistry("cos-home", ["agent-chief"]);
    const disp = mockDispatcher();
    const map = new Map([
      ["agent-chief", "C12345"],
      ["cos-home", "C99999"],
    ]);

    await checkFirstBoot(mem, reg, disp, map);

    const workItem = (disp.dispatch as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(workItem.source.id).toBe("C99999");
    expect(workItem.source.label).toBe("cos-home");
  });
});
