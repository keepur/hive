import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger } from "../logging/logger.js";
import type { SlackGateway } from "./slack-gateway.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { WorkItem } from "../types/work-item.js";

const log = createLogger("slack-internal-api");

export interface SlackInternalApiDeps {
  port: number;
  authToken: string;
  gateway: SlackGateway;
  agentManager: AgentManager;
}

interface SendBody {
  agent_id?: string;
  channel?: string;
  text?: string;
  thread_ts?: string;
  blocks?: unknown[];
  force_root?: boolean;
}

interface ReadBody {
  channel?: string;
  limit?: number;
}

interface ChannelsBody {
  query?: string;
}

interface UsersBody {
  user?: string;
}

export class SlackInternalApi {
  private port: number;
  private authToken: string;
  private gateway: SlackGateway;
  private agentManager: AgentManager;
  private server: Server | null = null;

  constructor(deps: SlackInternalApiDeps) {
    this.port = deps.port;
    this.authToken = deps.authToken;
    this.gateway = deps.gateway;
    this.agentManager = deps.agentManager;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error("HTTP handler error", { error: String(err) });
        this.sendJson(res, 500, { ok: false, error: "internal_server_error" });
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, "127.0.0.1", () => resolve());
    });

    log.info("Slack internal API started", { port: this.port });
  }

  async stop(): Promise<void> {
    if (this.server) {
      await new Promise<void>((resolve) => this.server!.close(() => resolve()));
      this.server = null;
    }
    log.info("Slack internal API stopped");
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${this.authToken}`) {
      this.sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }

    if (req.method !== "POST") {
      this.sendJson(res, 405, { ok: false, error: "method_not_allowed" });
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const path = url.pathname;

    let body: unknown = {};
    try {
      const raw = await this.readBody(req);
      body = raw ? JSON.parse(raw) : {};
    } catch {
      this.sendJson(res, 400, { ok: false, error: "invalid_json" });
      return;
    }

    switch (path) {
      case "/internal/slack/send":
        return this.handleSend(res, body as SendBody);
      case "/internal/slack/read":
        return this.handleRead(res, body as ReadBody);
      case "/internal/slack/channels":
        return this.handleChannels(res, body as ChannelsBody);
      case "/internal/slack/users":
        return this.handleUsers(res, body as UsersBody);
      case "/internal/slack/search":
        this.sendJson(res, 501, { ok: false, error: "search deferred pending tool-parity audit" });
        return;
      default:
        this.sendJson(res, 404, { ok: false, error: "not_found" });
        return;
    }
  }

  private async handleSend(res: ServerResponse, body: SendBody): Promise<void> {
    const { agent_id, channel, text, thread_ts, blocks, force_root } = body;
    if (!agent_id || !channel || typeof text !== "string") {
      this.sendJson(res, 400, { ok: false, error: "missing_required_fields" });
      return;
    }

    const resolvedChannelId = await this.gateway.resolveChannelId(channel);
    if (!resolvedChannelId) {
      this.sendJson(res, 404, { ok: false, error: "channel_not_found" });
      return;
    }

    let effectiveThreadTs: string | undefined;
    if (force_root) {
      effectiveThreadTs = undefined;
    } else if (thread_ts) {
      effectiveThreadTs = thread_ts;
    } else {
      effectiveThreadTs = this.pickFallbackThreadTs(agent_id, resolvedChannelId);
    }

    try {
      const ts = await this.gateway.postForInternalApi(resolvedChannelId, text, effectiveThreadTs, blocks);
      this.sendJson(res, 200, { ok: true, ts, channel: resolvedChannelId });
    } catch (err) {
      log.error("send failed", { channel: resolvedChannelId, error: String(err) });
      this.sendJson(res, 500, { ok: false, error: "post_failed" });
    }
  }

  private pickFallbackThreadTs(agentId: string, resolvedChannelId: string): string | undefined {
    const activeItems: WorkItem[] = this.agentManager.getActiveWorkItems(agentId) ?? [];
    const matches = activeItems.filter((wi) => wi.source?.id === resolvedChannelId);
    if (matches.length === 0) return undefined;
    const pick = matches[matches.length - 1];
    const meta = pick.meta ?? {};
    const threadTs = (meta as Record<string, unknown>).slackThreadTs;
    if (typeof threadTs === "string" && threadTs.length > 0) return threadTs;
    const ts = (meta as Record<string, unknown>).slackTs;
    if (typeof ts === "string" && ts.length > 0) return ts;
    return undefined;
  }

  private async handleRead(res: ServerResponse, body: ReadBody): Promise<void> {
    const { channel, limit } = body;
    if (!channel) {
      this.sendJson(res, 400, { ok: false, error: "missing_channel" });
      return;
    }
    const resolvedChannelId = await this.gateway.resolveChannelId(channel);
    if (!resolvedChannelId) {
      this.sendJson(res, 404, { ok: false, error: "channel_not_found" });
      return;
    }
    try {
      const messages = await this.gateway.historyForChannel(resolvedChannelId, limit);
      this.sendJson(res, 200, { ok: true, messages });
    } catch (err) {
      log.error("read failed", { channel: resolvedChannelId, error: String(err) });
      this.sendJson(res, 500, { ok: false, error: "read_failed" });
    }
  }

  private async handleChannels(res: ServerResponse, body: ChannelsBody): Promise<void> {
    try {
      const channels = await this.gateway.listConversations(body.query);
      this.sendJson(res, 200, { ok: true, channels });
    } catch (err) {
      log.error("channels list failed", { error: String(err) });
      this.sendJson(res, 500, { ok: false, error: "list_failed" });
    }
  }

  private async handleUsers(res: ServerResponse, body: UsersBody): Promise<void> {
    if (!body.user) {
      this.sendJson(res, 400, { ok: false, error: "missing_user" });
      return;
    }
    try {
      const user = await this.gateway.userInfo(body.user);
      this.sendJson(res, 200, { ok: true, user });
    } catch (err) {
      log.error("user info failed", { error: String(err) });
      this.sendJson(res, 500, { ok: false, error: "user_info_failed" });
    }
  }

  private sendJson(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let data = "";
      req.on("data", (chunk: Buffer) => {
        data += chunk.toString();
      });
      req.on("end", () => resolve(data));
      req.on("error", reject);
    });
  }
}
