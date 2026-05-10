import { describe, it, expect, vi } from "vitest";

vi.mock("../../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { resolveAgentForWsWorkItem } from "./ws-agent-resolver.js";
import type { WorkItem } from "../../types/work-item.js";
import type { AgentRegistry } from "../../agents/agent-registry.js";
import type { AgentManager } from "../../agents/agent-manager.js";

interface RegistryStubArgs {
  byOrigin?: Record<string, { id: string; disabled?: boolean }>;
  byId?: Record<string, { id: string; disabled?: boolean }>;
}

function makeRegistry(args: RegistryStubArgs = {}): AgentRegistry {
  const byOrigin = args.byOrigin ?? {};
  const byId = { ...(args.byId ?? {}) };
  // Hoist origin-defined agents into the id map so registry.get(id) works
  // when thread continuity / other paths look them up by id.
  for (const a of Object.values(byOrigin)) byId[a.id] = byId[a.id] ?? a;
  return {
    get: vi.fn((id: string) => byId[id]),
    findByOrigin: vi.fn((slug: string) => byOrigin[slug]),
  } as unknown as AgentRegistry;
}

function makeAgentManager(continuedAgentId?: string): AgentManager {
  return {
    findAgentForThread: vi.fn(async () => continuedAgentId),
  } as unknown as AgentManager;
}

function makeAppItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "msg-1",
    text: "hi",
    source: { kind: "app", id: "dev1", label: "app:Shop" },
    sender: "dev1",
    threadId: "app:dev1",
    timestamp: new Date(),
    meta: { deviceId: "dev1" },
    ...overrides,
  };
}

function makeTeamItem(overrides: Partial<WorkItem> = {}): WorkItem {
  return {
    id: "msg-1",
    text: "hi team",
    source: { kind: "team", id: "c1", label: "team:general" },
    sender: "dev1",
    threadId: "team:c1",
    timestamp: new Date(),
    meta: { deviceId: "dev1", channelId: "c1" },
    ...overrides,
  };
}

describe("resolveAgentForWsWorkItem (KPR-218)", () => {
  describe("step 1 — thread continuity", () => {
    it("prefers thread-continuity agent when one exists in the registry", async () => {
      const reg = makeRegistry({
        byOrigin: { "dodi-shop": { id: "wyatt" } },
        byId: { rae: { id: "rae" } },
      });
      const am = makeAgentManager("rae");
      const id = await resolveAgentForWsWorkItem(
        makeAppItem({ meta: { deviceId: "dev1", origin: "dodi-shop", defaultAgentId: "ignored" } }),
        reg,
        am,
        "default-agent",
      );
      expect(id).toBe("rae");
    });

    it("ignores stale continuation when continued agent no longer in registry", async () => {
      const reg = makeRegistry({
        byOrigin: { "dodi-shop": { id: "wyatt" } },
      });
      const am = makeAgentManager("ghost-agent");
      const id = await resolveAgentForWsWorkItem(
        makeAppItem({ meta: { deviceId: "dev1", origin: "dodi-shop" } }),
        reg,
        am,
        "default-agent",
      );
      // Falls through to origin routing.
      expect(id).toBe("wyatt");
    });

    it("does not consult continuation when threadId is missing", async () => {
      const reg = makeRegistry({ byId: { "default-agent": { id: "default-agent" } } });
      const am = makeAgentManager("rae");
      const item = makeAppItem();
      delete item.threadId;
      const id = await resolveAgentForWsWorkItem(item, reg, am, "default-agent");
      expect(id).toBe("default-agent");
      expect(am.findAgentForThread as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
    });
  });

  describe("step 2 — origin routing (app-kind)", () => {
    it("routes to the origin agent when meta.origin matches", async () => {
      const reg = makeRegistry({
        byOrigin: { "dodi-shop": { id: "wyatt" } },
      });
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(
        makeAppItem({ meta: { deviceId: "dev1", origin: "dodi-shop" } }),
        reg,
        am,
        "default-agent",
      );
      expect(id).toBe("wyatt");
    });

    it("returns null on origin miss (does NOT fall through to default)", async () => {
      const reg = makeRegistry({
        byId: { "default-agent": { id: "default-agent" } },
      });
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(
        makeAppItem({ meta: { deviceId: "dev1", origin: "unknown-origin", defaultAgentId: "default-agent" } }),
        reg,
        am,
        "default-agent",
      );
      // Origin set → drop on miss; mirrors dispatcher.ts:305-315.
      expect(id).toBeNull();
    });

    it("returns null when origin matches but the agent is disabled", async () => {
      const reg = makeRegistry({
        byOrigin: { "dodi-shop": { id: "wyatt", disabled: true } },
        byId: { "default-agent": { id: "default-agent" } },
      });
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(
        makeAppItem({ meta: { deviceId: "dev1", origin: "dodi-shop" } }),
        reg,
        am,
        "default-agent",
      );
      expect(id).toBeNull();
    });
  });

  describe("step 3 — DM targetAgentId (team-kind)", () => {
    it("routes to the targetAgentId for team DMs", async () => {
      const reg = makeRegistry({
        byId: { jessica: { id: "jessica" }, "default-agent": { id: "default-agent" } },
      });
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(
        makeTeamItem({
          meta: { deviceId: "dev1", channelId: "c1", targetAgentId: "jessica" },
        }),
        reg,
        am,
        "default-agent",
      );
      expect(id).toBe("jessica");
    });

    it("falls through to defaultAgentId when target is unknown to the registry", async () => {
      const reg = makeRegistry({
        byId: { "default-agent": { id: "default-agent" } },
      });
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(
        makeTeamItem({
          meta: { deviceId: "dev1", channelId: "c1", targetAgentId: "ghost-agent" },
        }),
        reg,
        am,
        "default-agent",
      );
      expect(id).toBe("default-agent");
    });

    it("falls through when target is disabled", async () => {
      const reg = makeRegistry({
        byId: { jessica: { id: "jessica", disabled: true }, "default-agent": { id: "default-agent" } },
      });
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(
        makeTeamItem({
          meta: { deviceId: "dev1", channelId: "c1", targetAgentId: "jessica" },
        }),
        reg,
        am,
        "default-agent",
      );
      expect(id).toBe("default-agent");
    });
  });

  describe("step 4 — meta.defaultAgentId", () => {
    it("uses meta.defaultAgentId when present and valid", async () => {
      const reg = makeRegistry({
        byId: { mokie: { id: "mokie" }, "default-agent": { id: "default-agent" } },
      });
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(
        makeAppItem({ meta: { deviceId: "dev1", defaultAgentId: "mokie" } }),
        reg,
        am,
        "default-agent",
      );
      expect(id).toBe("mokie");
    });

    it("falls through to constructor default when meta default is unknown", async () => {
      const reg = makeRegistry({
        byId: { "default-agent": { id: "default-agent" } },
      });
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(
        makeAppItem({ meta: { deviceId: "dev1", defaultAgentId: "ghost" } }),
        reg,
        am,
        "default-agent",
      );
      expect(id).toBe("default-agent");
    });
  });

  describe("step 5 — constructor defaultAgentId fallback", () => {
    it("falls back to constructor default when nothing else resolves", async () => {
      const reg = makeRegistry({
        byId: { "default-agent": { id: "default-agent" } },
      });
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(makeAppItem({ meta: { deviceId: "dev1" } }), reg, am, "default-agent");
      expect(id).toBe("default-agent");
    });

    it("returns null when constructor default is unknown to the registry", async () => {
      const reg = makeRegistry();
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(makeAppItem({ meta: { deviceId: "dev1" } }), reg, am, "ghost-default");
      expect(id).toBeNull();
    });

    it("returns null when nothing matches and no default is provided", async () => {
      const reg = makeRegistry();
      const am = makeAgentManager(undefined);
      const id = await resolveAgentForWsWorkItem(makeAppItem({ meta: { deviceId: "dev1" } }), reg, am, undefined);
      expect(id).toBeNull();
    });
  });
});
