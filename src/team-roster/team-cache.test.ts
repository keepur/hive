import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { TeamCache } from "./team-cache.js";

const mkContact = (over: Partial<any> = {}) => ({
  _id: new ObjectId(),
  name: "May Test",
  email: "may@dodihome.com",
  category: "team-human",
  ...over,
});

const mkAgentDef = (over: Partial<any> = {}) => ({
  _id: "mokie",
  name: "Mokie",
  title: "Chief of Staff",
  model: "claude-opus-4-7",
  homeBase: "agent-mokie",
  disabled: false,
  ...over,
});

function fakeContactsCol(rows: any[]) {
  return { find: vi.fn(() => ({ toArray: async () => rows })) } as any;
}

function fakeRegistry(defs: any[]) {
  return { getAllDefinitions: async () => defs } as any;
}

describe("TeamCache", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("populates humans lazily and reuses within TTL", async () => {
    const col = fakeContactsCol([mkContact()]);
    const cache = new TeamCache(col, fakeRegistry([]));
    await cache.getHumans();
    await cache.getHumans();
    expect(col.find).toHaveBeenCalledTimes(1);
  });

  it("repopulates after TTL expires", async () => {
    const col = fakeContactsCol([mkContact()]);
    const cache = new TeamCache(col, fakeRegistry([]));
    await cache.getHumans();
    vi.advanceTimersByTime(61_000);
    await cache.getHumans();
    expect(col.find).toHaveBeenCalledTimes(2);
  });

  it("invalidateHumans forces repopulate on next call", async () => {
    const col = fakeContactsCol([mkContact()]);
    const cache = new TeamCache(col, fakeRegistry([]));
    await cache.getHumans();
    cache.invalidateHumans();
    await cache.getHumans();
    expect(col.find).toHaveBeenCalledTimes(2);
  });

  it("filters humans by category in the Mongo query (team-human only — archived excluded since it's shared with deduped customer rows)", async () => {
    const col = fakeContactsCol([]);
    const cache = new TeamCache(col, fakeRegistry([]));
    await cache.getHumans();
    expect(col.find).toHaveBeenCalledWith({ category: "team-human" });
  });

  it("agents slice maps homeBase → slackChannel and disabled → archived", async () => {
    const cache = new TeamCache(
      fakeContactsCol([]),
      fakeRegistry([
        mkAgentDef({ _id: "rae", name: "Rae", homeBase: "agent-rae", disabled: false }),
        mkAgentDef({ _id: "mokie", name: "Mokie", homeBase: "agent-mokie", disabled: true }),
      ]),
    );
    const out = await cache.getAgents();
    const rae = out.find((m) => m.id === "rae")!;
    const mokie = out.find((m) => m.id === "mokie")!;
    expect(rae.slackChannel).toBe("agent-rae");
    expect(rae.category).toBe("team-agent");
    expect(rae.active).toBe(true);
    expect(mokie.category).toBe("archived");
    expect(mokie.active).toBe(false);
  });
});
