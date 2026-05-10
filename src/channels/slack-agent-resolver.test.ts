import { describe, it, expect, vi } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { resolveAgentForSlackWorkItem } from "./slack-agent-resolver.js";
import type { WorkItem } from "../types/work-item.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { AgentManager } from "../agents/agent-manager.js";

interface RegistryStubArgs {
  byChannel?: Record<string, { id: string; disabled?: boolean }>;
  byId?: Record<string, { id: string; disabled?: boolean }>;
}

function makeRegistry(args: RegistryStubArgs = {}): AgentRegistry {
  const byChannel = args.byChannel ?? {};
  const byId = { ...(args.byId ?? {}) };
  for (const a of Object.values(byChannel)) byId[a.id] = byId[a.id] ?? a;
  return {
    get: vi.fn((id: string) => byId[id]),
    findByChannel: vi.fn((ch: string) => byChannel[ch]),
  } as unknown as AgentRegistry;
}

function makeAgentManager(continuedAgentId?: string): AgentManager {
  return {
    findAgentForThread: vi.fn(async () => continuedAgentId),
  } as unknown as AgentManager;
}

function makeItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "msg-1",
    text: "hi",
    source: { kind: "slack", id: "C1", label: "general" },
    sender: "U1",
    threadId: "slack:C1:100.001",
    timestamp: new Date(),
    ...overrides,
  };
}

describe("resolveAgentForSlackWorkItem (KPR-217)", () => {
  it("prefers thread-continuity agent when one exists in the registry", async () => {
    const reg = makeRegistry({
      byChannel: { general: { id: "channel-owner" } },
      byId: { "rae": { id: "rae" } },
    });
    const am = makeAgentManager("rae");
    const id = await resolveAgentForSlackWorkItem(makeItem(), reg, am, "default-agent");
    expect(id).toBe("rae");
  });

  it("ignores stale continuation when continued agent no longer in registry", async () => {
    const reg = makeRegistry({
      byChannel: { general: { id: "channel-owner" } },
    });
    const am = makeAgentManager("ghost-agent");
    const id = await resolveAgentForSlackWorkItem(makeItem(), reg, am, "default-agent");
    expect(id).toBe("channel-owner");
  });

  it("falls through to channel binding when no continuation", async () => {
    const reg = makeRegistry({
      byChannel: { general: { id: "channel-owner" } },
    });
    const am = makeAgentManager(undefined);
    const id = await resolveAgentForSlackWorkItem(makeItem(), reg, am, "default-agent");
    expect(id).toBe("channel-owner");
  });

  it("skips disabled channel-binding agent and falls back to default", async () => {
    const reg = makeRegistry({
      byChannel: { general: { id: "channel-owner", disabled: true } },
      byId: { "default-agent": { id: "default-agent" } },
    });
    const am = makeAgentManager(undefined);
    const id = await resolveAgentForSlackWorkItem(makeItem(), reg, am, "default-agent");
    expect(id).toBe("default-agent");
  });

  it("falls back to defaultAgentId when no continuation and no channel binding", async () => {
    const reg = makeRegistry({
      byId: { "default-agent": { id: "default-agent" } },
    });
    const am = makeAgentManager(undefined);
    const id = await resolveAgentForSlackWorkItem(makeItem({ source: { kind: "slack", id: "C1", label: "untracked" } }), reg, am, "default-agent");
    expect(id).toBe("default-agent");
  });

  it("returns null when no continuation, no channel binding, and no default", async () => {
    const reg = makeRegistry();
    const am = makeAgentManager(undefined);
    const id = await resolveAgentForSlackWorkItem(makeItem({ source: { kind: "slack", id: "C1", label: "untracked" } }), reg, am, undefined);
    expect(id).toBeNull();
  });

  it("returns null when default agent is unknown to the registry", async () => {
    const reg = makeRegistry();
    const am = makeAgentManager(undefined);
    const id = await resolveAgentForSlackWorkItem(makeItem({ source: { kind: "slack", id: "C1", label: "untracked" } }), reg, am, "ghost-default");
    expect(id).toBeNull();
  });

  it("works when threadId is missing (no continuation lookup attempted)", async () => {
    const reg = makeRegistry({
      byChannel: { general: { id: "channel-owner" } },
    });
    const am = makeAgentManager(undefined);
    const item = makeItem();
    delete item.threadId;
    const id = await resolveAgentForSlackWorkItem(item, reg, am, "default-agent");
    expect(id).toBe("channel-owner");
    expect((am.findAgentForThread as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});
