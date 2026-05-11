import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger } from "../logging/logger.js";
import type { Collection } from "mongodb";
import type { AgentDefinition, AgentDefinitionVersion } from "../types/agent-definition.js";
import { AGENT_DEFINITION_DEFAULTS } from "../types/agent-definition.js";

const log = createLogger("admin-api");

// MongoDB _id filter casts: AgentDefinition uses string _id but the MongoDB driver
// types filter._id as ObjectId. The `as any` casts on `{ _id: id as any }` throughout
// this file are required to bridge this typing mismatch.

export class AdminApi {
  private server: ReturnType<typeof createServer>;
  private port: number;
  private token: string;
  private agentDefs: Collection<AgentDefinition>;
  private agentVersions: Collection<AgentDefinitionVersion>;
  private onReload: () => void;

  constructor(
    port: number,
    token: string,
    agentDefs: Collection<AgentDefinition>,
    agentVersions: Collection<AgentDefinitionVersion>,
    onReload: () => void,
  ) {
    this.port = port;
    this.token = token;
    this.agentDefs = agentDefs;
    this.agentVersions = agentVersions;
    this.onReload = onReload;
    this.server = createServer((req, res) => this.handleRequest(req, res));
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.server.listen(this.port, () => {
        log.info("Admin API started", { port: this.port });
        resolve();
      });
    });
  }

  stop(): void {
    this.server.close();
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Auth check — always required (index.ts only starts AdminApi when token is configured)
    const auth = req.headers.authorization;
    if (!auth || auth !== `Bearer ${this.token}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://localhost:${this.port}`);
    const path = url.pathname;
    const method = req.method ?? "GET";

    try {
      // Route matching
      if (path === "/admin/agents" && method === "GET") {
        return await this.listAgents(res);
      }
      if (path === "/admin/agents" && method === "POST") {
        return await this.createAgent(req, res);
      }

      const agentMatch = path.match(/^\/admin\/agents\/([^/]+)$/);
      if (agentMatch) {
        const id = decodeURIComponent(agentMatch[1]);
        if (method === "GET") return await this.getAgent(id, res);
        if (method === "PATCH") return await this.updateAgent(id, req, res);
        if (method === "DELETE") return await this.deleteAgent(id, res);
      }

      const enableMatch = path.match(/^\/admin\/agents\/([^/]+)\/(enable|disable)$/);
      if (enableMatch && method === "POST") {
        const id = decodeURIComponent(enableMatch[1]);
        const action = enableMatch[2] as "enable" | "disable";
        return await this.toggleAgent(id, action, res);
      }

      const historyMatch = path.match(/^\/admin\/agents\/([^/]+)\/history$/);
      if (historyMatch && method === "GET") {
        const id = decodeURIComponent(historyMatch[1]);
        const limit = parseInt(url.searchParams.get("limit") ?? "10", 10);
        return await this.agentHistory(id, limit, res);
      }

      const rollbackMatch = path.match(/^\/admin\/agents\/([^/]+)\/rollback$/);
      if (rollbackMatch && method === "POST") {
        const id = decodeURIComponent(rollbackMatch[1]);
        return await this.rollbackAgent(id, req, res);
      }

      // Server registry
      if (path === "/admin/servers" && method === "GET") {
        return await this.listServers(res);
      }

      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
    } catch (err) {
      log.error("Admin API error", { error: String(err), path, method });
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Internal server error" }));
    }
  }

  private async readBody(req: IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk) => chunks.push(chunk));
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString()));
        } catch {
          reject(new Error("Invalid JSON"));
        }
      });
      req.on("error", reject);
    });
  }

  private json(res: ServerResponse, status: number, data: any): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(data));
  }

  private async saveVersion(agentId: string, changedFields: string[]): Promise<void> {
    const current = await this.agentDefs.findOne({ _id: agentId as any });
    if (!current) return;
    await this.agentVersions.insertOne({
      agentId,
      snapshot: current as unknown as AgentDefinition,
      changedFields,
      createdAt: new Date(),
    });
  }

  private async listAgents(res: ServerResponse): Promise<void> {
    const docs = await this.agentDefs.find().toArray();
    this.json(res, 200, docs);
  }

  private async getAgent(id: string, res: ServerResponse): Promise<void> {
    const doc = await this.agentDefs.findOne({ _id: id as any });
    if (!doc) return this.json(res, 404, { error: "Agent not found" });
    this.json(res, 200, doc);
  }

  private async createAgent(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    if (!body._id || !body.name || !body.model) {
      return this.json(res, 400, { error: "Required: _id, name, model" });
    }

    const existing = await this.agentDefs.findOne({ _id: body._id as any });
    if (existing) return this.json(res, 409, { error: "Agent already exists" });

    const now = new Date();
    const doc: AgentDefinition = {
      _id: body._id,
      name: body.name,
      model: body.model,
      icon: body.icon ?? AGENT_DEFINITION_DEFAULTS.icon,
      channels: body.channels ?? [],
      passiveChannels: body.passiveChannels ?? AGENT_DEFINITION_DEFAULTS.passiveChannels,
      keywords: body.keywords ?? AGENT_DEFINITION_DEFAULTS.keywords,
      isDefault: body.isDefault ?? false,
      coreServers: body.coreServers ?? [],
      delegateServers: body.delegateServers ?? [],
      delegatePrompts: body.delegatePrompts ?? AGENT_DEFINITION_DEFAULTS.delegatePrompts,
      plugins: body.plugins,
      metadata: body.metadata,
      soul: body.soul ?? "",
      systemPrompt: body.systemPrompt ?? "",
      schedule: body.schedule ?? AGENT_DEFINITION_DEFAULTS.schedule,
      subscribe: body.subscribe,
      budgetUsd: body.budgetUsd ?? AGENT_DEFINITION_DEFAULTS.budgetUsd,
      maxTurns: body.maxTurns ?? AGENT_DEFINITION_DEFAULTS.maxTurns,
      maxConcurrent: body.maxConcurrent ?? AGENT_DEFINITION_DEFAULTS.maxConcurrent,
      // KPR-220 Phase 4: writes go to spawnBudget; maxConcurrent stays
      // populated for backward compat.
      spawnBudget: body.spawnBudget,
      timeoutMs: body.timeoutMs ?? AGENT_DEFINITION_DEFAULTS.timeoutMs,
      disabled: body.disabled ?? false,
      slackBot: body.slackBot,
      roles: body.roles ?? [],
      createdAt: now,
      updatedAt: now,
      updatedBy: "admin-api",
    };

    await this.agentDefs.insertOne(doc as any);
    this.onReload();
    this.json(res, 201, doc);
  }

  private async updateAgent(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const existing = await this.agentDefs.findOne({ _id: id as any });
    if (!existing) return this.json(res, 404, { error: "Agent not found" });

    // Don't allow changing immutable fields
    delete body._id;
    delete body.createdAt;

    const changedFields = Object.keys(body);
    await this.saveVersion(id, changedFields);

    await this.agentDefs.updateOne(
      { _id: id as any },
      { $set: { ...body, updatedAt: new Date(), updatedBy: "admin-api" } },
    );

    this.onReload();
    const updated = await this.agentDefs.findOne({ _id: id as any });
    this.json(res, 200, updated);
  }

  private async deleteAgent(id: string, res: ServerResponse): Promise<void> {
    const existing = await this.agentDefs.findOne({ _id: id as any });
    if (!existing) return this.json(res, 404, { error: "Agent not found" });

    await this.saveVersion(id, ["_deleted"]);
    await this.agentDefs.deleteOne({ _id: id as any });
    this.onReload();
    this.json(res, 200, { deleted: id });
  }

  private async toggleAgent(id: string, action: "enable" | "disable", res: ServerResponse): Promise<void> {
    const existing = await this.agentDefs.findOne({ _id: id as any });
    if (!existing) return this.json(res, 404, { error: "Agent not found" });

    await this.saveVersion(id, ["disabled"]);
    await this.agentDefs.updateOne(
      { _id: id as any },
      { $set: { disabled: action === "disable", updatedAt: new Date(), updatedBy: "admin-api" } },
    );

    this.onReload();
    this.json(res, 200, { [action + "d"]: id });
  }

  private async agentHistory(id: string, limit: number, res: ServerResponse): Promise<void> {
    const versions = await this.agentVersions.find({ agentId: id }).sort({ createdAt: -1 }).limit(limit).toArray();
    this.json(res, 200, versions);
  }

  private async rollbackAgent(id: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
    const body = await this.readBody(req);
    const versionIndex = body.version_index ?? 0;

    if (typeof versionIndex !== "number" || versionIndex < 0 || !Number.isInteger(versionIndex)) {
      return this.json(res, 400, { error: "version_index must be a non-negative integer" });
    }

    const versions = await this.agentVersions
      .find({ agentId: id })
      .sort({ createdAt: -1 })
      .skip(versionIndex)
      .limit(1)
      .toArray();

    if (versions.length === 0) {
      return this.json(res, 404, { error: "No version found at that index" });
    }

    // Save current state before rollback
    const existing = await this.agentDefs.findOne({ _id: id as any });
    if (!existing) return this.json(res, 404, { error: "Agent not found — cannot rollback a deleted agent" });
    await this.saveVersion(id, ["_rollback"]);

    const { _id, ...snapshotFields } = versions[0].snapshot as any;
    await this.agentDefs.updateOne(
      { _id: id as any },
      { $set: { ...snapshotFields, updatedAt: new Date(), updatedBy: "admin-api" } },
    );

    this.onReload();
    const restored = await this.agentDefs.findOne({ _id: id as any });
    this.json(res, 200, restored);
  }

  private async listServers(res: ServerResponse): Promise<void> {
    // Static server registry — derived from codebase, not DB
    // This can be expanded later; for now return a useful list
    this.json(res, 200, { message: "Server registry — use agent_definitions.coreServers/delegateServers fields" });
  }
}
