/**
 * KPR-348 (spec §D1-§D3, §D7): the Lane B tool bridge. Consumes the
 * KPR-347 bridgeable inventory partition and materializes it per transport
 * class, presenting EVERY tool to the model as a hive-wrapped function tool.
 * The single dispatch wrapper is where the guardrail gate, exception
 * containment (epic §D4 invariant: execute() NEVER throws), abort
 * propagation, and tool metrics live. Agent.mcpServers is never used (§D2).
 *
 * Provider-neutral by design: KPR-352/353 bind the same BridgedTool[] to
 * their SDK shapes. The MCP server client classes from @openai/agents-core
 * are provider-neutral MCP plumbing (no OpenAI API coupling) — deliberate
 * shared-core reuse (spec §Integration).
 */
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
// SPIKE(S1): confirmed import path for the MCP server classes.
import { MCPServerStdio, MCPServerStreamableHttp, MCPServerSSE } from "@openai/agents";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServerConfig, McpSdkServerConfigWithInstance } from "@anthropic-ai/claude-agent-sdk";
import { createLogger } from "../../logging/logger.js";
import type { WorkItemContext } from "../agent-runner.js";
import type { GuardrailDecision, GuardrailGate } from "./types.js";
import type { HiveToolInventoryEntry } from "./tool-transport.js";
import type { ProviderSkillIndexEntry, DelegateTurnRunner } from "./turn-assembly.js";
import { BuiltinExecutor, EXECUTOR_BACKED_BUILTIN_NAMES } from "./builtin-executor.js"; // executor-backed builtin dispatch
import { observeToolFailure, observeToolSuccess } from "../../ops/observe.js";

const log = createLogger("tool-bridge");

/** SPIKE(S3): units confirmed by the spike — adjust names/values to the recorded knobs. */
const CLIENT_SESSION_TIMEOUT_SECONDS = 30; // agents-core session RPCs — SECONDS
const TOOL_CALL_TIMEOUT_MS = 600_000; // MCP SDK RequestOptions.timeout — MILLISECONDS (aligned with Bash max)
/** OpenAI per-request tool limit (spec §D8). */
const MAX_PROVIDER_TOOLS = 128;
/** OpenAI function-name constraint (spec §D8). */
const TOOL_NAME_MAX = 64;
const TOOL_NAME_SAFE = /^[a-zA-Z0-9_-]+$/;

export interface BridgedTool {
  /** Provider-facing name — Claude-lane-identical (mcp__<server>__<tool>, or Bash/Read/…). */
  name: string;
  description: string;
  /** Normalized JSON schema (§D1.5): type/properties present, required + additionalProperties filled. */
  inputSchema: Record<string, unknown>;
  /** Gated + contained + metered. NEVER throws. Returns model-visible text. */
  execute(input: unknown): Promise<string>;
}

export interface ToolBridgeOptions {
  inventory: HiveToolInventoryEntry[];
  inProcessServers: Record<string, McpSdkServerConfigWithInstance>;
  gate: GuardrailGate;
  workItemContext?: WorkItemContext;
  signal: AbortSignal;
  /** Logging/telemetry label only (adapter passes its display name). */
  agentId: string;
  /**
   * KPR-454 D6: the agent_definitions SLUG, distinct from the display label
   * above. The second field needs a second name because `agentId` is already
   * taken here by the display label; `agentSlug` says which of the two
   * identities the bridge is holding at the one site that holds both.
   * Optional — absent ⇒ the published `agentId` detail key is omitted.
   * `agentId` keeps its documented meaning and all its existing log call
   * sites; nothing renames it.
   */
  agentSlug?: string;
  /** Resolved per-spawn session cwd (spec §D5-cwd) — builtin executor working dir. */
  sessionCwd: string;
  /** load_skill source (spec §D6) — populated by KPR-349's skill index. */
  skillIndex: ProviderSkillIndexEntry[];
  /**
   * KPR-354 (§D3): manager-owned nested-turn executor. Present ⇒
   * claude-subagent inventory entries synthesize the Task tool; absent ⇒
   * fail-dark (no Task tool, entries inert).
   */
  delegateRunner?: DelegateTurnRunner;
}

/**
 * Uniform client view over the three MCP mechanisms. NOTE (S1 spike record):
 * the Agents-SDK `MCPServerStdio`/`MCPServerStreamableHttp`/`MCPServerSSE`
 * `.callTool()` may resolve with the bare `content` array rather than the
 * full `CallToolResult` (where `isError` lives) — unlike the raw
 * `@modelcontextprotocol/sdk` `Client.callTool()` path used for in-process
 * servers, which always returns the full result shape. `openAgentsSdkConnection`
 * (below) must normalize its `callTool` to always resolve a full
 * `CallToolResult`-shaped value (synthesizing `{content, isError: false}`
 * when the SDK gave back a bare content array) so `isErrorResult`/
 * `shapeCallToolResult` in `discover()` behave uniformly across all three
 * MCP mechanisms — do not special-case discover() per transport.
 */
interface McpConnection {
  serverName: string;
  listTools(): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>>;
  callTool(toolName: string, args: Record<string, unknown>): Promise<unknown>;
  close(): Promise<void>;
}

type MutableStats = { toolCalls: number; toolMs: number; perTool: Map<string, number> };

export class ToolBridge {
  private readonly opts: ToolBridgeOptions;
  private readonly connections: McpConnection[] = [];
  private executor: BuiltinExecutor | null = null;
  private closed = false;
  private readonly _stats: MutableStats = { toolCalls: 0, toolMs: 0, perTool: new Map() };
  /**
   * Fail-soft connect/tool-cap omission record, appended throughout connect().
   * NOTE: nothing in production reads this array today — the actual honesty
   * surface at each omission site is the adjacent `log.warn(...)` call built
   * from local variables (agent id, error class, server name). Kept as a
   * per-turn record for tests and a future consumer; until one exists, treat
   * the log lines as the source of truth.
   */
  readonly runtimeOmissions: { server: string; reason: string }[] = [];

  constructor(opts: ToolBridgeOptions) {
    this.opts = opts;
  }

  get stats(): Readonly<MutableStats> {
    return this._stats;
  }

  /**
   * Connect all transports, discover schemas, build BridgedTool[].
   * Fail-soft per server (§D7): a failed connect/listTools drops that server
   * from this turn's surface (warn log: name + error class ONLY — never
   * configs/env), records a runtimeOmission, and the turn proceeds. The
   * whole method is additionally wrapped so it can NEVER throw out of
   * runTurn — connect errors are hive/tool-side, non-provider by nature.
   */
  async connect(): Promise<BridgedTool[]> {
    try {
      return await this.connectInner();
    } catch (err) {
      // Should be unreachable (per-server catches below) — belt-and-suspenders.
      log.warn("Tool bridge connect failed wholesale — running tool-less", {
        agent: this.opts.agentId,
        error: errorClass(err),
      });
      this.runtimeOmissions.push({ server: "*", reason: `bridge-connect: ${errorClass(err)}` });
      return [];
    }
  }

  private async connectInner(): Promise<BridgedTool[]> {
    const tools: BridgedTool[] = [];

    // Partition inventory entries by mechanism.
    const external = this.opts.inventory.filter(
      (e) => e.transport === "stdio" || e.transport === "http" || e.transport === "sse",
    );
    const inProcess = this.opts.inventory.filter((e) => e.transport === "sdk-in-process");
    const builtins = this.opts.inventory.filter(
      (e) => e.transport === "claude-builtin" && e.schemas.kind === "static",
    );
    // KPR-354 (§D3): claude-subagent entries — consumed by Task synthesis
    // ONLY. No MCP connection is opened for them at the parent level.
    const delegates = this.opts.inventory.filter((e) => e.transport === "claude-subagent");

    // External MCP servers: connect + discover in parallel, fail-soft each.
    const externalResults = await Promise.allSettled(
      external.map((entry) => this.connectExternal(entry)),
    );
    externalResults.forEach((res, i) => {
      const entry = external[i];
      if (res.status === "fulfilled") {
        tools.push(...res.value);
      } else {
        this.omit(entry.name, res.reason);
      }
    });

    // In-process: same handlers the Claude lane runs (KPR-122), over InMemoryTransport.
    const inProcessResults = await Promise.allSettled(
      inProcess.map((entry) => this.connectInProcess(entry)),
    );
    inProcessResults.forEach((res, i) => {
      const entry = inProcess[i];
      if (res.status === "fulfilled") {
        tools.push(...res.value);
      } else {
        this.omit(entry.name, res.reason);
      }
    });

    // Builtin executor (Task 2): static schemas, direct dispatch, no MCP hop.
    if (builtins.length > 0) {
      this.executor = new BuiltinExecutor({ cwd: this.opts.sessionCwd, signal: this.opts.signal });
      for (const entry of builtins) {
        if (entry.schemas.kind !== "static") continue;
        for (const def of entry.schemas.tools) {
          tools.push(
            this.wrap(def.name, def.description, normalizeSchema(def.inputSchema), (input) =>
              this.executor!.execute(def.name, input),
            ),
          );
        }
      }
    }

    // load_skill (spec §D6): rendered whenever the index is non-empty (KPR-349 populates skillIndex).
    const loadSkill = this.buildLoadSkillTool();
    if (loadSkill) tools.push(loadSkill);

    const taskTool = this.buildTaskTool(delegates);
    if (taskTool) tools.push(taskTool);

    return this.applyNameAndCapEdges(tools);
  }

  private async connectExternal(entry: HiveToolInventoryEntry): Promise<BridgedTool[]> {
    const cfg = entry.serverConfig;
    if (!cfg) throw new Error("missing serverConfig");
    // entry.transport is narrowed to the external set by the connectInner()
    // partition filter, but that narrowing does not cross the method boundary.
    const conn = await this.openAgentsSdkConnection(
      entry.name,
      entry.transport as "stdio" | "http" | "sse",
      cfg,
    );
    this.connections.push(conn);
    return this.discover(conn);
  }

  // SPIKE(S1/S3): constructor option names per the spike record. If S1 fell
  // back to the raw MCP SDK, this method builds Client + StdioClientTransport /
  // StreamableHTTPClientTransport instead — McpConnection shape unchanged.
  private async openAgentsSdkConnection(
    serverName: string,
    transport: "stdio" | "http" | "sse",
    cfg: McpServerConfig,
  ): Promise<McpConnection> {
    let server: { connect(): Promise<void>; listTools(): Promise<unknown>; callTool(n: string, a: Record<string, unknown> | null): Promise<unknown>; close(): Promise<void> };
    if (transport === "stdio") {
      const c = cfg as { command: string; args?: string[]; env?: Record<string, string> };
      server = new MCPServerStdio({
        name: serverName,
        command: c.command,
        args: c.args ?? [],
        env: c.env,
        cacheToolsList: true,
        clientSessionTimeoutSeconds: CLIENT_SESSION_TIMEOUT_SECONDS,
        timeout: TOOL_CALL_TIMEOUT_MS, // SPIKE(S3): knob + unit per record
      } as never);
    } else {
      const c = cfg as { url: string; headers?: Record<string, string> };
      const options = {
        name: serverName,
        url: c.url,
        requestInit: c.headers ? { headers: c.headers } : undefined,
        cacheToolsList: true,
        clientSessionTimeoutSeconds: CLIENT_SESSION_TIMEOUT_SECONDS,
        timeout: TOOL_CALL_TIMEOUT_MS, // SPIKE(S3)
      };
      server = transport === "http"
        ? new MCPServerStreamableHttp(options as never)
        : new MCPServerSSE(options as never);
    }
    await server.connect();
    return {
      serverName,
      listTools: async () => (await server.listTools()) as Array<{ name: string; description?: string; inputSchema?: unknown }>,
      callTool: async (toolName, args) => {
        const raw = await server.callTool(toolName, args);
        // NOTE (S1 spike): the agents-SDK server's callTool may resolve the
        // bare content array rather than a full CallToolResult (where isError
        // lives) — unlike the raw MCP Client path (connectInProcess) which
        // always returns the full shape. Normalize here so discover()'s
        // isErrorResult/shapeCallToolResult behave uniformly across all
        // three MCP mechanisms.
        return raw && typeof raw === "object" && "content" in (raw as Record<string, unknown>)
          ? raw
          : { content: raw, isError: false };
      },
      close: () => server.close(),
    };
  }

  private async connectInProcess(entry: HiveToolInventoryEntry): Promise<BridgedTool[]> {
    const sdkServer = this.opts.inProcessServers[entry.name];
    if (!sdkServer) throw new Error("no in-process instance in assembly");
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    // Same McpServer instance, same handlers, same *ContextRef closures (KPR-122).
    await sdkServer.instance.connect(serverTransport);
    const client = new Client({ name: `hive-bridge-${entry.name}`, version: "1.0.0" });
    await client.connect(clientTransport);
    const conn: McpConnection = {
      serverName: entry.name,
      listTools: async () => (await client.listTools()).tools,
      callTool: async (toolName, args) =>
        client.callTool({ name: toolName, arguments: args }, undefined, { timeout: TOOL_CALL_TIMEOUT_MS }),
      close: () => client.close(),
    };
    this.connections.push(conn);
    return this.discover(conn);
  }

  private async discover(conn: McpConnection): Promise<BridgedTool[]> {
    const listed = await conn.listTools();
    return listed.map((t) =>
      this.wrap(
        `mcp__${conn.serverName}__${t.name}`,
        t.description ?? "",
        normalizeSchema(t.inputSchema),
        async (input) => {
          const result = await conn.callTool(t.name, asRecord(input));
          // MCP SDK contract: a handler THROW makes callTool RESOLVE with
          // {isError: true, content: [...]} — it does not reject. Convert
          // that here into a throw so wrap()'s catch applies the single
          // containment prefix ("Tool execution failed (<name>): …") and
          // records the failure the same way every other failure path
          // does (gate throw, builtin throw, transport-level rejection) —
          // no separate isError-branch duplicating that logic.
          if (isErrorResult(result)) throw new Error(shapeCallToolResult(result));
          return shapeCallToolResult(result);
        },
      ),
    );
  }

  /**
   * THE dispatch wrapper (spec §D3): gate → execute → contain → meter.
   * Structurally cannot throw — the epic §D4 containment invariant's
   * structural half. Order and text shapes are contract-tested (T1).
   */
  private wrap(
    name: string,
    description: string,
    inputSchema: Record<string, unknown>,
    underlying: (input: unknown) => Promise<string>,
  ): BridgedTool {
    return {
      name,
      description,
      inputSchema,
      execute: async (input: unknown): Promise<string> => {
        let decision: GuardrailDecision;
        try {
          decision = await this.opts.gate({
            toolName: name,
            input,
            workItemContext: this.opts.workItemContext,
          });
        } catch (err) {
          // Gate THROW is a DENY (typed contract, types.ts:119-126).
          decision = { behavior: "deny", reason: `guardrail gate error: ${errorText(err)}` };
        }
        if (decision.behavior === "deny") {
          // PreToolUse parity: model-visible denial, turn continues.
          return `Tool call denied by policy: ${decision.reason}`;
        }
        if (this.opts.signal.aborted) {
          return `Tool execution aborted (${name}).`;
        }
        const t0 = Date.now();
        try {
          const result = await underlying(input);
          this.record(name, Date.now() - t0);
          // KPR-454 D3, the recovery half. Two arguments and no others — the
          // same closed pair the Claude lane's success hook passes.
          //
          // ⚠ NO ABORT CHECK HERE, deliberately (spec-faithful, unchanged), and
          // the DIRECTION of the resulting cross-lane skew is worth stating
          // rather than leaving to be re-derived. This success site has no
          // `signal.aborted` guard while the failure site below does, and the
          // Claude lane's PostToolUse hook checks `wasAborted` — so on Lane B an
          // aborted turn can still CLOSE a condition (an early boundary, which
          // means the next failure of that tool advances an epoch), where on the
          // Claude lane it cannot (a delayed boundary). Both are bounded at ONE
          // boundary, with opposite signs; the consequence for a reader is that
          // a cross-lane tool-health view sees Lane B epochs advancing slightly
          // more eagerly than Claude-lane ones for the same tool.
          //
          // ⚠ EXECUTOR-BACKED BUILTINS AND `Task` ARE SKIPPED HERE, found by
          // KPR-454's retroactive Frontier hard-gate review (KPR-451#comment
          // register, merge c068ee33). `BuiltinExecutor` and the delegate Task
          // runner are contractually never-throw: a Bash non-zero exit, a
          // missing Read/Edit target, or a failed delegate Task all RESOLVE as
          // result text (`Tool execution failed (Bash): …`, `Read failed: …`,
          // `Task failed: …`), so this success branch cannot tell a real
          // success from a logical failure without sniffing that text — which
          // C12 forbids (outcome must come from control flow, not inferred
          // from a string). Calling `observeToolSuccess` anyway would store a
          // FALSE `tool-recovered` fact and close a condition (possibly one
          // the Claude lane correctly opened for the same tool), which is
          // worse than the accepted gap: the failure side already cannot
          // observe these failures either (they never reach the catch below),
          // so this keeps the asymmetry honestly one-sided — no signal — in
          // place of a wrong one. MCP-discovered tools are unaffected: a
          // handler-side error is converted to a throw in `discover()`
          // specifically so it reaches the catch, so a resolved result here
          // for those really is a success.
          if (!EXECUTOR_BACKED_BUILTIN_NAMES.has(name) && name !== "Task") {
            observeToolSuccess({ tool: name, lane: "laneB" });
          }
          return result;
        } catch (err) {
          this.record(name, Date.now() - t0);
          // KPR-454 D3, the failure half. THE single Lane B capture point:
          // every Lane B failure passes through this one catch — an MCP
          // isError converted to a throw in discover() (which throws
          // PRECISELY so this catch handles it), a builtin throw, a transport
          // rejection, a delegate Task fault. Nothing is added at discover().
          //
          // Own-abort suppresses: an abort DURING execution surfaces as a
          // rejection and would otherwise be indistinguishable from a fault.
          // Reading the signal here is Lane B's exact analogue of the Claude
          // lane's `wasAborted`, and the two lanes must suppress the same
          // class or the tool-health view is lane-skewed.
          if (!this.opts.signal.aborted) {
            observeToolFailure({
              // `name` is the CANONICAL name the wrapper closed over —
              // mcp__<server>__<tool> or a builtin — BEFORE
              // applyNameAndCapEdges sanitizes/truncates/de-collides for
              // provider constraints. That method builds a new object and
              // never rewrites this closure, so Claude/Lane A/Lane B rows for
              // one tool share a subject.id (AC11).
              tool: name,
              error: errorText(err),
              lane: "laneB",
              agentId: this.opts.agentSlug,
              workItemId: this.opts.workItemContext?.workItemId,
              threadId: this.opts.workItemContext?.threadId,
              durationMs: Date.now() - t0,
              // D6's "the bridge's own TOOL_CALL_TIMEOUT_MS path", supplied as
              // the typed signal it actually arrives as. That constant is
              // handed to the MCP SDK as RequestOptions.timeout, and the SDK
              // rejects with a JSON-RPC McpError whose numeric `.code` is
              // -32001 — which classifyToolError maps to `timeout` ahead of
              // any text test. Read defensively: `err` is `unknown` and most
              // throws here carry no `code` at all.
              signals: {
                mcpErrorCode:
                  typeof (err as { code?: unknown })?.code === "number"
                    ? ((err as { code: number }).code)
                    : undefined,
              },
            });
          }
          // Mirrors the KPR-122 in-process structured-error invariant.
          return `Tool execution failed (${name}): ${errorText(err)}`;
        }
      },
    };
  }

  private buildLoadSkillTool(): BridgedTool | null {
    if (this.opts.skillIndex.length === 0) return null;
    const byName = new Map(this.opts.skillIndex.map((s) => [s.name, s]));
    return this.wrap(
      "load_skill",
      "Load a skill's full instructions (its SKILL.md) by name. Only names from the skill list are valid.",
      {
        type: "object",
        properties: { name: { type: "string", description: "Skill name from the skill list" } },
        required: ["name"],
        additionalProperties: false,
      },
      async (input) => {
        const name = (asRecord(input) as { name?: unknown }).name;
        if (typeof name !== "string") return "load_skill failed: 'name' must be a string";
        // Path-validated by construction: paths come from the assembly's
        // index, never from the model (spec §D6 — minimal read-and-return).
        const entry = byName.get(name);
        if (!entry) return `load_skill failed: unknown skill '${name}'`;
        return await readFile(entry.path, "utf8");
      },
    );
  }

  /**
   * KPR-354 (§D3): ONE Claude-lane-identical Task function tool synthesized
   * from the claude-subagent entries. Name + input schema match the SDK's
   * Task tool (description/prompt/subagent_type) so archetype rules written
   * against `Task` transfer verbatim (KPR-348 name-preservation canon);
   * subagent_type is enum-restricted to the active delegate names. Routed
   * through wrap(): gate-deny, pre-execute abort check, containment, and
   * metering all come free — Task wall time lands in stats.toolMs, so the
   * parent's llmMs correctly excludes nested-turn time. No name collision
   * with the Task BUILTIN entry: that one is claude-only, partition-omitted
   * on Lane B, so this is the only Task in the bridged surface.
   */
  private buildTaskTool(entries: HiveToolInventoryEntry[]): BridgedTool | null {
    const runner = this.opts.delegateRunner;
    if (!runner || entries.length === 0) return null;
    const byName = new Map(entries.map((e) => [e.name, e]));
    const names = [...byName.keys()];
    const listing = entries.map((e) => `- ${e.name} — ${e.description ?? e.name}`).join("\n");
    return this.wrap(
      "Task",
      "Launch a delegate subagent to handle a task using one of your delegated capability MCPs. " +
        "The delegate runs a bounded turn with that server's tools and returns its result.\n" +
        "Available delegates (subagent_type):\n" +
        listing,
      {
        type: "object",
        properties: {
          description: { type: "string", description: "A short (3-5 word) summary of the task" },
          prompt: { type: "string", description: "The task for the delegate to perform" },
          subagent_type: {
            type: "string",
            enum: names,
            description: "The delegate to use (see the list in the tool description)",
          },
        },
        required: ["description", "prompt", "subagent_type"],
        additionalProperties: false,
      },
      async (input) => {
        const args = asRecord(input) as { prompt?: unknown; subagent_type?: unknown };
        const subagentType = args.subagent_type;
        if (typeof subagentType !== "string" || !byName.has(subagentType)) {
          return `Task failed: unknown subagent_type '${String(subagentType)}'. Valid: ${names.join(", ")}`;
        }
        if (typeof args.prompt !== "string" || args.prompt.length === 0) {
          return "Task failed: 'prompt' must be a non-empty string";
        }
        // Runner contract: NEVER throws (D5.7) — wrap()'s catch is
        // belt-and-suspenders on top.
        return await runner({
          delegate: subagentType,
          prompt: args.prompt,
          entry: byName.get(subagentType)!,
          signal: this.opts.signal,
          workItemContext: this.opts.workItemContext,
        });
      },
    );
  }

  /** Spec §D8 edges: sanitize/truncate-with-hash, collision dedupe, 128 cap. */
  private applyNameAndCapEdges(tools: BridgedTool[]): BridgedTool[] {
    const seen = new Set<string>();
    const out: BridgedTool[] = [];
    for (const t of tools) {
      let name = t.name;
      if (!TOOL_NAME_SAFE.test(name) || name.length > TOOL_NAME_MAX) {
        const cleaned = name.replace(/[^a-zA-Z0-9_-]/g, "_");
        const hash = createHash("sha256").update(t.name).digest("hex").slice(0, 7);
        name = `${cleaned.slice(0, TOOL_NAME_MAX - 8)}_${hash}`;
        log.warn("Tool name sanitized for provider constraints", { agent: this.opts.agentId, original: t.name, mapped: name });
      }
      let candidate = name;
      let n = 2;
      while (seen.has(candidate)) {
        candidate = `${name.slice(0, TOOL_NAME_MAX - 2 - String(n).length)}_${n}`;
        n += 1;
        log.warn("Tool name collision — deterministic suffix applied", { agent: this.opts.agentId, name: candidate });
      }
      seen.add(candidate);
      out.push(candidate === t.name ? t : { ...t, name: candidate });
    }
    if (out.length > MAX_PROVIDER_TOOLS) {
      // KPR-349 §D7 ruling + KPR-354: Tier 0 — the six executor builtins,
      // load_skill, AND Task (≤8 tools) are structurally load-bearing (the
      // toolkit and the Task description claim them) and are NEVER
      // cap-dropped. Tier 1 — everything else (MCP-discovered) keeps
      // inventory order and takes the entire tail-drop.
      const pinnedNames = new Set<string>([...EXECUTOR_BACKED_BUILTIN_NAMES, "load_skill", "Task"]);
      const pinned = out.filter((t) => pinnedNames.has(t.name));
      const tier1 = out.filter((t) => !pinnedNames.has(t.name));
      const tier1Budget = MAX_PROVIDER_TOOLS - pinned.length;
      const dropped = tier1.slice(tier1Budget);
      for (const d of dropped) this.runtimeOmissions.push({ server: d.name, reason: "provider-tool-cap" });
      log.warn("Bridged tool surface exceeds provider cap — Tier-1 tail dropped (builtins + load_skill pinned)", {
        agent: this.opts.agentId,
        cap: MAX_PROVIDER_TOOLS,
        pinned: pinned.map((t) => t.name),
        dropped: dropped.map((d) => d.name),
      });
      const surviving = new Set([...pinned, ...tier1.slice(0, tier1Budget)]);
      return out.filter((t) => surviving.has(t));
    }
    return out;
  }

  /**
   * Idempotent. Closes every MCP connection, kills builtin children.
   * NEVER throws and never rejects (final-review advisory 1): each server's
   * close is individually caught-and-logged so one faulting close cannot
   * skip the rest or reject runTurn's finally.
   */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.executor?.killAll();
    await Promise.all(
      this.connections.map(async (conn) => {
        try {
          await conn.close();
        } catch (err) {
          log.warn("MCP connection close failed (ignored)", {
            agent: this.opts.agentId,
            server: conn.serverName,
            error: errorClass(err),
          });
        }
      }),
    );
  }

  private omit(server: string, err: unknown): void {
    // KPR-347 secrecy rule: names + error CLASS only — never configs/env.
    log.warn("Tool bridge server unavailable this turn — omitted (fail-soft)", {
      agent: this.opts.agentId,
      server,
      error: errorClass(err),
    });
    this.runtimeOmissions.push({ server, reason: errorClass(err) });
  }

  private record(name: string, ms: number): void {
    this._stats.toolCalls += 1;
    this._stats.toolMs += ms;
    this._stats.perTool.set(name, (this._stats.perTool.get(name) ?? 0) + 1);
  }
}

/** §D1.5/§D8: fill normalized defaults when absent; pass through otherwise. */
export function normalizeSchema(schema: unknown): Record<string, unknown> {
  const s = (schema && typeof schema === "object" ? { ...(schema as Record<string, unknown>) } : {}) as Record<string, unknown>;
  if (s.type === undefined) s.type = "object";
  if (s.properties === undefined) s.properties = {};
  if (s.required === undefined) s.required = [];
  if (s.additionalProperties === undefined) s.additionalProperties = false;
  return s;
}

/** True when a CallToolResult reports a handler-side error (resolves, does not reject — see discover()). */
function isErrorResult(result: unknown): boolean {
  return Boolean((result as { isError?: boolean } | undefined)?.isError);
}

/** §D3.1: MCP CallToolResult → model-visible text. */
export function shapeCallToolResult(result: unknown): string {
  const content = (result as { content?: Array<Record<string, unknown>> })?.content;
  if (!Array.isArray(content)) return typeof result === "string" ? result : JSON.stringify(result ?? "");
  return content
    .map((item) =>
      item.type === "text"
        ? String(item.text ?? "")
        : `[non-text content: ${String(item.type)} — not supported on this provider lane]`,
    )
    .join("\n");
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === "object" && !Array.isArray(input)) return input as Record<string, unknown>;
  if (typeof input === "string") {
    try {
      const parsed = JSON.parse(input) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch {
      /* fall through */
    }
  }
  return {};
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function errorClass(err: unknown): string {
  // KPR-347 secrecy rule: error CLASS only — never the message (which can
  // carry configs/env/paths); trimmed to err.name per plan-review round-1.
  if (err instanceof Error) return err.name;
  return String(err);
}
