import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { AdminApi } from "./admin-api.js";

function mockCollection() {
  const docs = new Map();
  return {
    _docs: docs,
    find: vi.fn((filter?: any) => {
      const filtered = filter?.agentId
        ? [...docs.values()].filter((d: any) => d.agentId === filter.agentId)
        : [...docs.values()];
      return {
        toArray: vi.fn().mockResolvedValue(filtered),
        sort: vi.fn().mockReturnThis(),
        limit: vi.fn().mockReturnThis(),
        skip: vi.fn().mockReturnThis(),
      };
    }),
    findOne: vi.fn(({ _id }: any) => Promise.resolve(docs.get(_id) ?? null)),
    insertOne: vi.fn((doc: any) => {
      docs.set(doc._id ?? `auto-${docs.size}`, { ...doc });
      return Promise.resolve({ insertedId: doc._id });
    }),
    updateOne: vi.fn(({ _id }: any, update: any) => {
      const d = docs.get(_id);
      if (d && update.$set) Object.assign(d, update.$set);
      return Promise.resolve({ modifiedCount: d ? 1 : 0 });
    }),
    deleteOne: vi.fn(({ _id }: any) => {
      const had = docs.has(_id);
      docs.delete(_id);
      return Promise.resolve({ deletedCount: had ? 1 : 0 });
    }),
    replaceOne: vi.fn(({ _id }: any, doc: any, _opts?: any) => {
      docs.set(_id, { ...doc });
      return Promise.resolve({ modifiedCount: 1 });
    }),
    createIndex: vi.fn().mockResolvedValue("ok"),
  };
}

function makeAgent(overrides: Record<string, any> = {}) {
  return {
    _id: "test-agent",
    name: "Test Agent",
    model: "sonnet",
    icon: "",
    channels: [],
    passiveChannels: [],
    keywords: [],
    isDefault: false,
    coreServers: [],
    delegateServers: [],
    delegatePrompts: {},
    soul: "",
    systemPrompt: "",
    schedule: [],
    budgetUsd: 10,
    maxTurns: 200,
    maxConcurrent: 3,
    timeoutMs: 300000,
    disabled: false,
    createdAt: new Date(),
    updatedAt: new Date(),
    updatedBy: "admin-api",
    ...overrides,
  };
}

describe("AdminApi", () => {
  let api: AdminApi;
  let agentDefs: ReturnType<typeof mockCollection>;
  let agentVersions: ReturnType<typeof mockCollection>;
  let onReload: ReturnType<typeof vi.fn>;
  let baseUrl: string;
  const TOKEN = "test-secret-token";

  // Use a random port to avoid conflicts
  const port = 0; // OS will assign a random port

  beforeEach(async () => {
    agentDefs = mockCollection();
    agentVersions = mockCollection();
    onReload = vi.fn();
    api = new AdminApi(0, TOKEN, agentDefs as any, agentVersions as any, onReload);
    await api.start();
    // Extract the actual port from the server
    const addr = (api as any).server.address();
    baseUrl = `http://localhost:${addr.port}`;
  });

  afterEach(() => {
    api.stop();
  });

  function authHeaders() {
    return { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" };
  }

  // --- Auth ---

  describe("authentication", () => {
    it("rejects requests without token", async () => {
      const res = await fetch(`${baseUrl}/admin/agents`);
      expect(res.status).toBe(401);
      const body = await res.json();
      expect(body.error).toBe("Unauthorized");
    });

    it("rejects requests with wrong token", async () => {
      const res = await fetch(`${baseUrl}/admin/agents`, {
        headers: { Authorization: "Bearer wrong" },
      });
      expect(res.status).toBe(401);
    });

    it("accepts requests with correct token", async () => {
      const res = await fetch(`${baseUrl}/admin/agents`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
    });

    it("rejects all requests when token is empty (auth always required)", async () => {
      const noAuthApi = new AdminApi(0, "", agentDefs as any, agentVersions as any, onReload);
      await noAuthApi.start();
      const addr = (noAuthApi as any).server.address();
      try {
        const res = await fetch(`http://localhost:${addr.port}/admin/agents`);
        expect(res.status).toBe(401);
      } finally {
        noAuthApi.stop();
      }
    });
  });

  // --- Route matching ---

  describe("route matching", () => {
    it("returns 404 for unknown routes", async () => {
      const res = await fetch(`${baseUrl}/admin/unknown`, { headers: authHeaders() });
      expect(res.status).toBe(404);
    });

    it("returns 404 for wrong method on known route", async () => {
      const res = await fetch(`${baseUrl}/admin/agents`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });
  });

  // --- List agents ---

  describe("GET /admin/agents", () => {
    it("returns empty list when no agents", async () => {
      const res = await fetch(`${baseUrl}/admin/agents`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toEqual([]);
    });

    it("returns all agents", async () => {
      const agent = makeAgent();
      agentDefs._docs.set("test-agent", agent);
      const res = await fetch(`${baseUrl}/admin/agents`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toHaveLength(1);
      expect(body[0]._id).toBe("test-agent");
    });
  });

  // --- Get agent ---

  describe("GET /admin/agents/:id", () => {
    it("returns 404 for missing agent", async () => {
      const res = await fetch(`${baseUrl}/admin/agents/nope`, { headers: authHeaders() });
      expect(res.status).toBe(404);
    });

    it("returns existing agent", async () => {
      const agent = makeAgent();
      agentDefs._docs.set("test-agent", agent);
      const res = await fetch(`${baseUrl}/admin/agents/test-agent`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("Test Agent");
    });
  });

  // --- Create agent ---

  describe("POST /admin/agents", () => {
    it("validates required fields", async () => {
      const res = await fetch(`${baseUrl}/admin/agents`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ name: "Test" }),
      });
      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Required");
    });

    it("rejects duplicate _id", async () => {
      agentDefs._docs.set("dup", makeAgent({ _id: "dup" }));
      const res = await fetch(`${baseUrl}/admin/agents`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ _id: "dup", name: "Dup", model: "sonnet" }),
      });
      expect(res.status).toBe(409);
    });

    it("creates agent with defaults", async () => {
      const res = await fetch(`${baseUrl}/admin/agents`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ _id: "new-agent", name: "New", model: "haiku" }),
      });
      expect(res.status).toBe(201);
      const body = await res.json();
      expect(body._id).toBe("new-agent");
      expect(body.model).toBe("haiku");
      expect(body.maxConcurrent).toBe(3);
      expect(body.budgetUsd).toBe(10);
      expect(body.disabled).toBe(false);
      expect(body.channels).toEqual([]);
      expect(onReload).toHaveBeenCalled();
    });

    it("stores the created agent in the collection", async () => {
      await fetch(`${baseUrl}/admin/agents`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ _id: "stored", name: "Stored", model: "sonnet" }),
      });
      expect(agentDefs.insertOne).toHaveBeenCalled();
      expect(agentDefs._docs.has("stored")).toBe(true);
    });
  });

  // --- Update agent ---

  describe("PATCH /admin/agents/:id", () => {
    it("returns 404 for missing agent", async () => {
      const res = await fetch(`${baseUrl}/admin/agents/nope`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ name: "Updated" }),
      });
      expect(res.status).toBe(404);
    });

    it("saves version before mutation", async () => {
      agentDefs._docs.set("upd", makeAgent({ _id: "upd" }));
      await fetch(`${baseUrl}/admin/agents/upd`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ name: "Updated Name" }),
      });
      expect(agentVersions.insertOne).toHaveBeenCalled();
      const versionCall = agentVersions.insertOne.mock.calls[0][0];
      expect(versionCall.agentId).toBe("upd");
      expect(versionCall.changedFields).toContain("name");
    });

    it("strips _id from update body", async () => {
      agentDefs._docs.set("keep-id", makeAgent({ _id: "keep-id" }));
      await fetch(`${baseUrl}/admin/agents/keep-id`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ _id: "new-id", name: "Updated" }),
      });
      // The updateOne $set should not contain _id
      const updateCall = agentDefs.updateOne.mock.calls[0][1];
      expect(updateCall.$set._id).toBeUndefined();
      expect(updateCall.$set.name).toBe("Updated");
    });

    it("calls onReload after update", async () => {
      agentDefs._docs.set("rel", makeAgent({ _id: "rel" }));
      await fetch(`${baseUrl}/admin/agents/rel`, {
        method: "PATCH",
        headers: authHeaders(),
        body: JSON.stringify({ model: "opus" }),
      });
      expect(onReload).toHaveBeenCalled();
    });
  });

  // --- Delete agent ---

  describe("DELETE /admin/agents/:id", () => {
    it("returns 404 for missing agent", async () => {
      const res = await fetch(`${baseUrl}/admin/agents/ghost`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("saves version and deletes agent", async () => {
      agentDefs._docs.set("doomed", makeAgent({ _id: "doomed" }));
      const res = await fetch(`${baseUrl}/admin/agents/doomed`, {
        method: "DELETE",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.deleted).toBe("doomed");
      expect(agentVersions.insertOne).toHaveBeenCalled();
      expect(agentDefs._docs.has("doomed")).toBe(false);
      expect(onReload).toHaveBeenCalled();
    });
  });

  // --- Enable/Disable ---

  describe("POST /admin/agents/:id/enable|disable", () => {
    it("returns 404 for missing agent", async () => {
      const res = await fetch(`${baseUrl}/admin/agents/nope/disable`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(404);
    });

    it("disables an agent", async () => {
      agentDefs._docs.set("tog", makeAgent({ _id: "tog", disabled: false }));
      const res = await fetch(`${baseUrl}/admin/agents/tog/disable`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.disabled).toBe("tog");
      const updateSet = agentDefs.updateOne.mock.calls[0][1].$set;
      expect(updateSet.disabled).toBe(true);
    });

    it("enables an agent", async () => {
      agentDefs._docs.set("tog2", makeAgent({ _id: "tog2", disabled: true }));
      const res = await fetch(`${baseUrl}/admin/agents/tog2/enable`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.enabled).toBe("tog2");
      const updateSet = agentDefs.updateOne.mock.calls[0][1].$set;
      expect(updateSet.disabled).toBe(false);
    });

    it("saves version on toggle", async () => {
      agentDefs._docs.set("v", makeAgent({ _id: "v" }));
      await fetch(`${baseUrl}/admin/agents/v/disable`, {
        method: "POST",
        headers: authHeaders(),
      });
      expect(agentVersions.insertOne).toHaveBeenCalled();
      expect(agentVersions.insertOne.mock.calls[0][0].changedFields).toContain("disabled");
    });
  });

  // --- History ---

  describe("GET /admin/agents/:id/history", () => {
    it("returns version history", async () => {
      const version = {
        _id: "v1",
        agentId: "hist",
        snapshot: makeAgent({ _id: "hist" }),
        changedFields: ["name"],
        createdAt: new Date(),
      };
      agentVersions._docs.set("v1", version);
      const res = await fetch(`${baseUrl}/admin/agents/hist/history`, {
        headers: authHeaders(),
      });
      expect(res.status).toBe(200);
      expect(agentVersions.find).toHaveBeenCalledWith({ agentId: "hist" });
    });
  });

  // --- Rollback ---

  describe("POST /admin/agents/:id/rollback", () => {
    it("returns 404 when no version found", async () => {
      const res = await fetch(`${baseUrl}/admin/agents/none/rollback`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ version_index: 0 }),
      });
      expect(res.status).toBe(404);
    });

    it("saves current state and restores snapshot", async () => {
      const oldSnapshot = makeAgent({ _id: "rb", name: "Old Name" });
      const version = {
        _id: "ver1",
        agentId: "rb",
        snapshot: oldSnapshot,
        changedFields: ["name"],
        createdAt: new Date(),
      };
      agentVersions._docs.set("ver1", version);
      agentDefs._docs.set("rb", makeAgent({ _id: "rb", name: "Current Name" }));

      const res = await fetch(`${baseUrl}/admin/agents/rb/rollback`, {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ version_index: 0 }),
      });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.name).toBe("Old Name");
      // saveVersion called for current state before rollback, then updateOne to restore
      expect(agentVersions.insertOne).toHaveBeenCalled();
      expect(agentDefs.updateOne).toHaveBeenCalled();
      expect(onReload).toHaveBeenCalled();
    });
  });

  // --- Servers ---

  describe("GET /admin/servers", () => {
    it("returns server registry info", async () => {
      const res = await fetch(`${baseUrl}/admin/servers`, { headers: authHeaders() });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.message).toBeDefined();
    });
  });
});
