import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import type { Db, Collection } from "mongodb";
import { ObjectId } from "mongodb";
import { TeamCache } from "./team-cache.js";

interface FakeCollection<T> {
  find: (...args: unknown[]) => { toArray: () => Promise<T[]> };
  __findCalls: number;
}

function makeFakeCollection<T>(docs: T[]): FakeCollection<T> {
  const handle = {
    __findCalls: 0,
    find(_filter?: unknown) {
      handle.__findCalls++;
      return { toArray: async () => docs };
    },
  };
  return handle;
}

function makeDb(opts: { contacts?: FakeCollection<unknown>; agentDefs?: FakeCollection<unknown> } = {}): Db {
  return {
    collection(name: string) {
      if (name === "contacts") return opts.contacts as unknown as Collection<unknown>;
      if (name === "agent_definitions") return opts.agentDefs as unknown as Collection<unknown>;
      throw new Error(`unexpected collection ${name}`);
    },
  } as unknown as Db;
}

describe("TeamCache", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-02T12:00:00Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("getHumans returns mapped TeamMembers from contacts collection", async () => {
    const id = new ObjectId();
    const contacts = makeFakeCollection([
      {
        _id: id,
        name: "May Huang",
        firstName: "May",
        lastName: "Huang",
        email: "may@dodihome.com",
        role: "CEO",
        pronouns: "she/her",
        category: "team-human",
        updatedAt: new Date("2026-05-01T00:00:00Z"),
      },
    ]);
    const cache = new TeamCache(makeDb({ contacts }));
    const humans = await cache.getHumans();
    expect(humans).toHaveLength(1);
    expect(humans[0]).toMatchObject({
      kind: "human",
      id: id.toHexString(),
      name: "May Huang",
      email: "may@dodihome.com",
      role: "CEO",
      pronouns: "she/her",
      category: "team-human",
    });
  });

  it("preserves archived category on humans", async () => {
    const contacts = makeFakeCollection([
      {
        _id: new ObjectId(),
        name: "Former",
        email: "former@dodihome.com",
        category: "archived",
      },
    ]);
    const cache = new TeamCache(makeDb({ contacts }));
    const [member] = await cache.getHumans();
    expect(member.category).toBe("archived");
  });

  it("falls back to firstName + lastName when name is empty", async () => {
    const contacts = makeFakeCollection([
      {
        _id: new ObjectId(),
        name: "",
        firstName: "First",
        lastName: "Last",
        email: null,
        category: "team-human",
      },
    ]);
    const cache = new TeamCache(makeDb({ contacts }));
    const [member] = await cache.getHumans();
    expect(member.name).toBe("First Last");
    expect(member.email).toBeUndefined();
  });

  it("getAgents maps agent_definitions correctly; disabled→archived", async () => {
    const agentDefs = makeFakeCollection([
      {
        _id: "jasper",
        name: "Jasper",
        model: "claude-sonnet-4-6",
        homeBase: "agent-jasper",
        channels: ["dev", "agent-jasper"],
        aliases: ["jas"],
      },
      {
        _id: "nora",
        name: "Nora",
        model: "claude-sonnet-4-6",
        channels: ["agent-nora"],
        disabled: true,
      },
    ]);
    const cache = new TeamCache(makeDb({ agentDefs }));
    const agents = await cache.getAgents();
    expect(agents).toHaveLength(2);
    const jasper = agents.find((a) => a.agentId === "jasper")!;
    expect(jasper).toMatchObject({
      kind: "agent",
      name: "Jasper",
      category: "team-agent",
      slackChannel: "agent-jasper",
      model: "claude-sonnet-4-6",
      aliases: ["jas"],
      active: true,
    });
    const nora = agents.find((a) => a.agentId === "nora")!;
    expect(nora).toMatchObject({
      category: "archived",
      slackChannel: "agent-nora",
      active: false,
    });
  });

  it("caches humans within TTL — second call does not re-query", async () => {
    const contacts = makeFakeCollection([]);
    const cache = new TeamCache(makeDb({ contacts }));
    await cache.getHumans();
    await cache.getHumans();
    expect(contacts.__findCalls).toBe(1);
  });

  it("caches agents within TTL — second call does not re-query", async () => {
    const agentDefs = makeFakeCollection([]);
    const cache = new TeamCache(makeDb({ agentDefs }));
    await cache.getAgents();
    await cache.getAgents();
    expect(agentDefs.__findCalls).toBe(1);
  });

  it("re-queries after TTL_MS expires", async () => {
    const contacts = makeFakeCollection([]);
    const cache = new TeamCache(makeDb({ contacts }));
    await cache.getHumans();
    vi.advanceTimersByTime(60_001);
    await cache.getHumans();
    expect(contacts.__findCalls).toBe(2);
  });

  it("invalidateHumans clears humans slice but not agents", async () => {
    const contacts = makeFakeCollection([]);
    const agentDefs = makeFakeCollection([]);
    const cache = new TeamCache(makeDb({ contacts, agentDefs }));
    await cache.getHumans();
    await cache.getAgents();
    cache.invalidateHumans();
    await cache.getHumans();
    await cache.getAgents();
    expect(contacts.__findCalls).toBe(2);
    expect(agentDefs.__findCalls).toBe(1);
  });

  it("invalidateAgents clears agents slice but not humans", async () => {
    const contacts = makeFakeCollection([]);
    const agentDefs = makeFakeCollection([]);
    const cache = new TeamCache(makeDb({ contacts, agentDefs }));
    await cache.getHumans();
    await cache.getAgents();
    cache.invalidateAgents();
    await cache.getHumans();
    await cache.getAgents();
    expect(contacts.__findCalls).toBe(1);
    expect(agentDefs.__findCalls).toBe(2);
  });
});
