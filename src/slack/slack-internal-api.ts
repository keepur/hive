import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger } from "../logging/logger.js";
import type { SlackGateway } from "./slack-gateway.js";
import type { AgentManager } from "../agents/agent-manager.js";

const log = createLogger("slack-internal-api");

export interface SlackInternalApiOptions {
  port: number;
  authToken: string;
  gateway: SlackGateway;
  agentManager: AgentManager;
}

export class SlackInternalApi {
  private port: number;
  private authToken: string;
  private gateway: SlackGateway;
  private agentManager: AgentManager;
  private server: Server | null = null;

  constructor(opts: SlackInternalApiOptions) {
    this.port = opts.port;
    this.authToken = opts.authToken;
    this.gateway = opts.gateway;
    this.agentManager = opts.agentManager;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error("HTTP handler error", { error: String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
      });
    });

    await new Promise<void>((resolve) => {
      this.server!.listen(this.port, "127.0.0.1", () => resolve());
    });

    log.info("Slack internal API started", { port: this.port });
  }

  async stop(): Promise<void> {
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    log.info("Slack internal API stopped");
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Only accept POST
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "method not allowed" }));
      return;
    }

    // Bearer auth
    const authHeader = req.headers.authorization;
    if (authHeader !== `Bearer ${this.authToken}`) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    const url = new URL(req.url ?? "/", `http://127.0.0.1:${this.port}`);
    const body = await this.readBody(req);
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(body) as Record<string, unknown>;
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid JSON body" }));
      return;
    }

    switch (url.pathname) {
      case "/internal/slack/send":
        return this.handleSend(parsed, res);
      case "/internal/slack/read":
        return this.handleRead(parsed, res);
      case "/internal/slack/channels":
        return this.handleChannels(parsed, res);
      case "/internal/slack/users":
        return this.handleUsers(parsed, res);
      case "/internal/slack/search":
        res.writeHead(501, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "search deferred pending tool-parity audit" }));
        return;
      default:
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not found" }));
    }
  }

  private async handleSend(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { agent_id, channel, text, thread_ts, blocks: _blocks, force_root } = body as {
      agent_id?: string;
      channel?: string;
      text?: string;
      thread_ts?: string;
      blocks?: unknown;
      force_root?: boolean;
    };

    // blocks is accepted but ignored in v1 — gateway.postAndRegister does not accept blocks.
    // Add blocks support when any agent seed actually needs it (tracked in Follow-ups).

    if (typeof channel !== "string" || !channel) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "channel is required" }));
      return;
    }

    if (typeof text !== "string" || !text) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "text is required" }));
      return;
    }

    const resolvedChannelId = await this.gateway.resolveChannelId(channel);
    if (!resolvedChannelId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: `unknown channel: ${channel}` }));
      return;
    }

    let threadTs: string | undefined = thread_ts;

    // Threading fallback: if no explicit thread_ts and not force_root, look up the active WorkItem
    // for this agent on this channel and use its thread ts.
    if (!threadTs && !force_root && typeof agent_id === "string" && agent_id) {
      const activeItems = this.agentManager.getActiveWorkItems(agent_id);
      // Filter to items whose source channel matches the resolved channel ID.
      // source.id is the channel ID (not source.channelId).
      const channelItems = activeItems.filter((w) => w.source.id === resolvedChannelId);
      if (channelItems.length > 0) {
        // Pick the most recently started (last in array — T4 appends in order).
        const latest = channelItems[channelItems.length - 1];
        threadTs =
          (latest.meta?.slackThreadTs as string | undefined) ??
          (latest.meta?.slackTs as string | undefined);
      }
    }

    const result = await this.gateway.postAndRegister(resolvedChannelId, text, threadTs);

    res.writeHead(result.ok ? 200 : 500, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result));
  }

  private async handleRead(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { channel, limit } = body as { channel?: string; limit?: number };

    if (typeof channel !== "string" || !channel) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "channel is required" }));
      return;
    }

    const messages = await this.gateway.readChannel(channel, typeof limit === "number" ? limit : undefined);

    if (messages === undefined) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "failed to read channel history" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, messages }));
  }

  private async handleChannels(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { query } = body as { query?: string };

    const channels = await this.gateway.listChannels(typeof query === "string" ? query : undefined);

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, channels }));
  }

  private async handleUsers(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { user } = body as { user?: string };

    if (typeof user !== "string" || !user) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "user is required" }));
      return;
    }

    const userInfo = await this.gateway.readUser(user);

    if (userInfo === undefined) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "failed to look up user" }));
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, user: userInfo }));
  }

  private readBody(req: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = "";
      req.on("data", (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on("end", () => resolve(body));
      req.on("error", reject);
    });
  }
}
