import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import { createLogger } from "../logging/logger.js";
import type { SlackGateway } from "./slack-gateway.js";
import type { AgentManager } from "../agents/agent-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import { describeSendFailure } from "./slack-send-errors.js";

const log = createLogger("slack-internal-api");

export interface SlackInternalApiOptions {
  port: number;
  authToken: string;
  gateway: SlackGateway;
  agentManager: AgentManager;
  /**
   * KPR-492 D1: the same AgentRegistry SlackAdapter.deliver reads
   * (`slack-adapter.ts:183`). Injected rather than reached through AgentManager
   * (whose `registry` is private and none of whose public `agentId`-taking
   * methods returns the `AgentConfig` — `getState` returns the runtime
   * `AgentState`), and rather than given to the gateway (which stays a pure
   * transport with no agent knowledge). The registry is mutated in place by
   * SIGUSR1 reloads, so a held reference stays live.
   */
  registry: AgentRegistry;
}

export class SlackInternalApi {
  private port: number;
  private authToken: string;
  private gateway: SlackGateway;
  private agentManager: AgentManager;
  private registry: AgentRegistry;
  private server: Server | null = null;

  constructor(opts: SlackInternalApiOptions) {
    this.port = opts.port;
    this.authToken = opts.authToken;
    this.gateway = opts.gateway;
    this.agentManager = opts.agentManager;
    this.registry = opts.registry;
  }

  async start(): Promise<void> {
    this.server = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error("HTTP handler error", { error: String(err) });
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "Internal server error" }));
      });
    });

    // KPR-492 (pre-PR review round 2): `listen` needs an 'error' listener. Without
    // one, an EADDRINUSE emits on an EventEmitter with no handler and throws out of
    // a libuv callback as an uncaughtException — index.ts installs only an
    // `unhandledRejection` handler (`index.ts:1052`), so the process dies and
    // launchd KeepAlive restarts it: a silent crash loop. This awaits above the
    // spawn-capable boundary, so the promise must also always settle, exactly once.
    // Policy follows D10's precedent one call earlier in this same hoisted block
    // (`slack-scope-preflight.ts`): log loudly and continue — "a single optional
    // Slack feature should not crash hive startup". Continuing costs agents' Slack
    // MCP tool calls, which then fail at call time with a connection error: loud at
    // the point of use, and strictly better than a boot loop that takes every
    // non-Slack surface down with it.
    const bound = await new Promise<boolean>((resolve) => {
      const server = this.server!;
      const onBindError = (err: NodeJS.ErrnoException) => {
        // Drop the handle: nothing ever bound, so stop() must not close it.
        this.server = null;
        log.error("Slack internal API failed to bind — agents' Slack MCP tools will fail with a connection error", {
          port: this.port,
          error: String(err),
          likelyCause: `port ${this.port} is already in use`,
        });
        resolve(false);
      };
      server.once("error", onBindError);
      server.listen(this.port, "127.0.0.1", () => {
        server.removeListener("error", onBindError);
        // Leave a handler installed for the bound server's lifetime — a
        // listener-less 'error' would throw for the same reason as above, and this
        // process installs no uncaughtException handler.
        server.on("error", (err) =>
          log.error("Slack internal API server error", { port: this.port, error: String(err) }),
        );
        resolve(true);
      });
    });
    if (!bound) return;

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
      // KPR-492 D5: /internal/slack/search is GONE, not 501. Slack's
      // search.messages is a user-token method — `search:read` is not grantable
      // to a bot token — so there is no bot-transport implementation to write,
      // and the name was never hosted-parity either. The route falls through to
      // the 404 default and the tool is removed from the shim.
      default:
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "not found" }));
    }
  }

  private async handleSend(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const {
      agent_id,
      channel,
      text,
      thread_ts,
      blocks: _blocks,
      force_root,
    } = body as {
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

    // KPR-492 D4: the full six-rung ladder — user forms allowed on the SEND path
    // only. `true` is passed explicitly at the call site because the parameter is
    // required, so §5.3's asymmetry is a visible decision here and cannot be
    // inherited by omission.
    const resolved = await this.gateway.resolveConversation(channel, true);
    if (!resolved.ok) {
      // KPR-492 D2: the resolver's failures go through the SAME mapper as the
      // post's. cannot_dm_bot / user_not_found / user_disabled / users_not_found
      // are raised by conversations.open / users.lookupByEmail inside the
      // resolver and never reach a chat.postMessage sink, so mapping only the sink
      // would leave those rows permanently unreachable. Hive-authored reasons
      // (ambiguity, "is a person, not a channel", "unknown channel: …") carry no
      // Slack code and pass through verbatim by the unmapped-code rule. The mapper
      // is two-argument: it never sees a resolved id, by construction.
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: describeSendFailure(channel, resolved.error) }));
      return;
    }
    const resolvedChannelId = resolved.id;

    // KPR-492 D1: per-agent identity. When agent_id is present but unresolved,
    // warn and post plainly — the floor is "not a human", and a labelled-generic
    // post beats a dropped one. "Unresolved" covers a removed agent, a registry
    // gap, AND a disabled agent: the registry drops disabled definitions from its
    // active map at load (agent-registry.ts:350-357), so `get()` (:607) misses
    // them — spec edge 19 is a registry miss, not a name-only post.
    // An `icon: ""` is falsy, so postSingle sends username only against the
    // default app icon — correct today; §10 step 1 owns the data.
    const agentConfig = typeof agent_id === "string" && agent_id ? this.registry.get(agent_id) : undefined;
    if (typeof agent_id === "string" && agent_id && !agentConfig) {
      log.warn("Unknown agent_id on Slack send — posting without identity", { agentId: agent_id });
    }
    const identity = agentConfig ? { name: agentConfig.name, icon: agentConfig.icon } : undefined;

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
        threadTs = (latest.meta?.slackThreadTs as string | undefined) ?? (latest.meta?.slackTs as string | undefined);
      }
    }

    const result = await this.gateway.postAndRegister(resolvedChannelId, text, threadTs, identity);

    if (!result.ok) {
      // 500 keeps the visibility chain intact: apiPost throws (slack-mcp-server.ts:65-68)
      // and the tool returns isError: true. The channel was always loud; the CONTENT was not.
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          // `channel` is the AGENT's string — the D… advice keys on it, never on
          // resolvedChannelId, which the two-argument mapper cannot even see.
          error: describeSendFailure(channel, result.error ?? "postMessage returned no ts"),
        }),
      );
      return;
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, ts: result.ts, channel: resolvedChannelId }));
  }

  private async handleRead(body: Record<string, unknown>, res: ServerResponse): Promise<void> {
    const { channel, limit } = body as { channel?: string; limit?: number };

    if (typeof channel !== "string" || !channel) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "channel is required" }));
      return;
    }

    // The tool schema advertises "channel ID or bare name", and conversations.history
    // only accepts IDs, so resolve here too.
    // KPR-492 D4/§5.3: `false` — rungs 1/2/6 only, the same input set this path
    // accepts today modulo the tighter id regex and the rung-0 mention unwrap.
    // Rungs 3-5 call conversations.open, which is a WRITE (it opens a DM), and
    // whether the D… it returns can then be READ depends on im:history — which the
    // manifest grants but the engine does not declare (not in REQUIRED_BOT_SCOPES,
    // spec §3/§5.3), so the outcome is token-dependent and the tool contract could
    // state neither honestly. Advertising @handle here would ship a side-effecting
    // path with an unstatable contract. The reason is surfaced VERBATIM —
    // describeSendFailure is a send-path mapper and its remedies would be wrong
    // advice on a read.
    const resolved = await this.gateway.resolveConversation(channel, false);
    if (!resolved.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: resolved.error }));
      return;
    }
    const resolvedChannelId = resolved.id;

    const messages = await this.gateway.readChannel(resolvedChannelId, typeof limit === "number" ? limit : undefined);

    if (messages === undefined) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          ok: false,
          error: `failed to read channel history for ${channel} (${resolvedChannelId}): ${
            this.gateway.lastReadError ?? "unknown error"
          }`,
        }),
      );
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

    // KPR-492 D4: resolve first, so the tool's long-advertised "user ID (U…) or
    // display name" contract is true for the first time. `resolveUserId` passes
    // U…/W… through with no users.list page-through, so the id case costs exactly
    // what it costs today. A resolution failure is a 400 carrying the resolver's
    // reason VERBATIM (unmapped — send-path remedies are wrong advice on a
    // profile read); a users.info failure stays the 500 below.
    const resolvedUser = await this.gateway.resolveUserId(user);
    if (!resolvedUser.ok) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: resolvedUser.error }));
      return;
    }

    const userInfo = await this.gateway.readUser(resolvedUser.id);

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
