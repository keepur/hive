# KPR-456 plan chunk 4 — lifecycle, provider wiring and CLI

Parent: [implementation plan](kpr-456-plan.md). Depends on chunks 1–3.

## Task 9: One drainable runtime capability

**Create:** src/obligations/runtime.ts

- [ ] Add the complete runtime assembly below.

~~~typescript
import { randomUUID } from "node:crypto";
import type { Db } from "mongodb";
import { type DeliveryCapability, fail } from "./types.js";
import { ObligationStore } from "./store.js";
import { ReceiptStore } from "./receipts.js";
import { DeliveryService, safeError } from "./delivery.js";
import { ObligationReader } from "./reader.js";
import { ObligationSweeper } from "./sweeper.js";
import { SlackObligationPoster, type ObligationPoster } from "./slack-post.js";

export class ObligationRuntime implements DeliveryCapability {
  readonly store: ObligationStore;
  readonly receipts: ReceiptStore;
  readonly reader: ObligationReader;
  readonly delivery: DeliveryService;
  readonly sweeper: ObligationSweeper;
  private transport?: ObligationPoster;
  private initialized = false;
  private ready = false;
  private stopping = false;
  private readonly inFlight = new Set<Promise<unknown>>();
  constructor(
    db: Db, retentionDays: number,
    readonly canWrite: () => boolean,
    readonly clock: () => Date = () => new Date(),
    readonly bootId = randomUUID(),
    readonly suppliedPoster?: ObligationPoster,
  ) {
    this.store = new ObligationStore(db);
    this.receipts = new ReceiptStore(db, retentionDays);
    this.reader = new ObligationReader(this.store, this.receipts, clock);
    const poster: ObligationPoster = {
      post: (destination, text) => this.transport
        ? this.transport.post(destination, text)
        : Promise.resolve({ kind: "unknown", reason: "unconfirmed_response" }),
    };
    this.delivery = new DeliveryService(this.store, this.receipts, poster, bootId, clock, canWrite);
    this.sweeper = new ObligationSweeper(this.store, this.receipts, this.delivery, poster, bootId, clock, canWrite);
  }
  async init(): Promise<void> {
    await this.store.init();
    await this.receipts.init();
    this.initialized = true;
  }
  async start(botToken: string, echo: (channel: string, ts: string) => void): Promise<void> {
    if (this.ready || this.stopping) return;
    if (!this.initialized) return fail("not_initialized");
    this.transport = this.suppliedPoster ?? new SlackObligationPoster(botToken, echo, this.canWrite, this.clock);
    this.ready = true;
    await this.sweeper.start();
  }
  private track(run: () => Promise<unknown>): Promise<unknown> {
    const promise = run().finally(() => { this.inFlight.delete(promise); });
    this.inFlight.add(promise);
    return promise;
  }
  discover(agentId: string, input: unknown): Promise<unknown> {
    if (this.stopping || !this.initialized || !this.canWrite()) return Promise.resolve({ state: "unavailable" });
    return this.track(async () => {
      try { return await this.reader.discover(agentId, input); }
      catch (err) { return { state: "inspection_unavailable", reason: safeError(err) }; }
    });
  }
  deliver(agentId: string, input: unknown): Promise<unknown> {
    if (!this.ready || this.stopping) return Promise.resolve({ state: "unavailable", retryAllowed: false });
    return this.track(async () => {
      try { return await this.delivery.deliver(agentId, input); }
      catch (err) { return { state: "delivery_outcome_unknown", reason: safeError(err), retryAllowed: false }; }
    });
  }
  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    await this.sweeper.stop();
    await Promise.allSettled([...this.inFlight]);
    this.transport = undefined;
  }
}
~~~

init() failure must propagate before wiring readiness. Discovery reads may be available after init, but sends remain unavailable until Slack setup supplies the transport. stop() rejects new calls, drains the checker and all admitted requests/receipt writes, then releases the transport. Do not put an unbounded turn-manager wait in this subsystem.

## Task 10: Extend the existing schedule server with strict input validation

**Modify:** src/schedule/schedule-mcp-server.ts: imports, ScheduleToolDeps, createScheduleMcpServer
**Test:** src/schedule/schedule-mcp-server.test.ts, src/agents/provider-adapters/tool-bridge.test.ts

- [ ] Retain the existing WorkItemContextRef type-only import and add the obligations import and optional dependency. The resulting imports include:

~~~typescript
import type { WorkItemContextRef } from "../agents/agent-runner.js";
import {
  type DeliveryCapability, deliveryInputSchema, discoveryInputSchema,
} from "../obligations/types.js";
~~~

~~~typescript
export interface ScheduleToolDeps {
  /** Optional live runtime context; never copy it into a stored document. */
  workItemContext?: WorkItemContextRef;
  db: Db;
  agentId: string;
  obligations?: DeliveryCapability;
}
~~~

- [ ] Replace createScheduleMcpServer with the following. Keep buildScheduleTools and all legacy tools unchanged.

~~~typescript
export function createScheduleMcpServer(deps: ScheduleToolDeps) {
  const server = createSdkMcpServer({
    name: "schedule",
    version: "0.1.0",
    tools: buildScheduleTools(deps),
  });
  const response = (value: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(value) }],
  });
  // Register full strict Zod objects. Passing only .shape through the SDK
  // tool() helper would silently strip unknown keys before our handler.
  server.instance.registerTool("my_delivery_obligations", {
    description: "List your registered delivery obligations and current keys. Use section overdue and nextCursor for older unresolved keys; sending/unknown/history entries are not invitations to retry.",
    inputSchema: discoveryInputSchema,
  }, async (input) => {
    if (!deps.obligations) return {
      isError: true, ...response({ state: "unavailable" }),
    };
    return response(await deps.obligations.discover(deps.agentId, input));
  });
  server.instance.registerTool("deliver_obligation", {
    description: "Send one registered obligation occurrence as a complete Slack text deliverable (at most 3900 characters including attribution). Use its explicit dueAt key. An unknown outcome must not be reposted; no success flag or destination can be supplied.",
    inputSchema: deliveryInputSchema,
  }, async (input) => {
    if (!deps.obligations) return {
      isError: true, ...response({ state: "unavailable", retryAllowed: false }),
    };
    return response(await deps.obligations.deliver(deps.agentId, input));
  });
  return server;
}
~~~

Use the real MCP request transport to verify extra fields are rejected before the capability runs. An unknown post outcome is structured content with retryAllowed:false, not a generic retryable tool failure. Missing service is an explicit unavailable error.

## Task 11: Forward one capability through both existing provider paths

**Modify:** src/agents/agent-runner.ts: AgentRunnerOptions, fields, constructor, existing schedule-server construction around baseline line 1540
**Modify:** src/agents/agent-manager.ts: fields/setter and normal createProviderAdapter around baseline line 822

- [ ] Add the type-only import to both files:

~~~typescript
import type { DeliveryCapability } from "../obligations/types.js";
~~~

- [ ] In AgentRunnerOptions add:

~~~typescript
obligations?: DeliveryCapability;
~~~

- [ ] In AgentRunner fields add and initialize in its constructor:

~~~typescript
private readonly obligations?: DeliveryCapability;
~~~

~~~typescript
this.obligations = runnerOptions?.obligations;
~~~

- [ ] Extend only the existing createScheduleMcpServer argument at the already gated construction site, preserving every existing dependency:

~~~typescript
this.scheduleMcpServer = createScheduleMcpServer({
  db: this.db,
  agentId: this.agentConfig.id,
  workItemContext: this.workItemContextRef,
  obligations: this.obligations,
});
~~~

Preserve buildInProcessServers(context)'s unconditional this.workItemContextRef.current = context refresh before cached-server lookup, including absent context. Pass the live reference itself, never a captured workItemId or context snapshot. Do not change shouldEnableInProcessServer, autoInjectedServerNames, filterCoreServers, or the worker denylist.

- [ ] In AgentManager add:

~~~typescript
private deliveryObligations?: DeliveryCapability;

setDeliveryObligations(capability: DeliveryCapability): void {
  this.deliveryObligations = capability;
}
~~~

- [ ] Replace normal-runner options construction in createProviderAdapter with:

~~~typescript
const runnerOptions: AgentRunnerOptions | undefined =
  laneAPassthrough || this.workerPool || this.deliveryObligations
    ? {
        laneAPassthrough,
        workerPool: this.workerPool,
        obligations: this.deliveryObligations,
      }
    : undefined;
~~~

The same runner feeds Claude and assembleProviderTurn/ToolBridge for Lane B. No provider ABI extension is needed. The worker factory remains exactly { suppressAutoInjectedServers: true }; it must not receive obligations, even if a later containment mistake exposes a schedule server.

- [ ] After the Task 22 SDK mock extension, retain and run the existing KPR-453 regression cases. In src/agents/agent-runner.test.ts, preserve "every enabled cached MCP gets live identity without cross-runner leakage", including its schedule factory reference, shared-reference identity, A/B/empty/absent-context refresh, cached-instance reuse and separate-runner assertions. Preserve the existing complete-context assembly and real ToolBridge round-trip/gate assertions. The standalone callers in chunks 6–7 may omit context; the runner still supplies its live reference with current=undefined, and obligation inputs/receipts gain no workItemId field.

~~~bash
npx vitest run src/agents/agent-runner.test.ts src/agents/provider-adapters/turn-assembly.test.ts src/agents/provider-adapters/tool-bridge.test.ts -t 'KPR-453'
~~~

Expected: exit 0 and all selected KPR-453 cases pass. This focused check supplements the full provider/containment regression command in the parent Testing Contract.

## Task 12: Initialize before spawns; enable after Slack; drain before shutdown

**Modify:** src/index.ts
**Test:** src/boot-order.test.ts

- [ ] Import ObligationRuntime. Immediately before the current optional ActivityLogger block (after shared guarded Db creation and before AgentManager construction), insert:

~~~typescript
const obligations = new ObligationRuntime(
  db, config.activity.retentionDays, () => !writeGuard.engaged,
);
await obligations.init();
~~~

This initialization is unconditional and outside if(config.activity.enabled). Its receipt TTL matches the existing logger. An empty registry produces no messages.

- [ ] Immediately after new AgentManager(...) and before activateProviderPlugins(), insert:

~~~typescript
agentManager.setDeliveryObligations(obligations);
~~~

- [ ] Immediately after await slackAdapter.start(...) resolves, insert:

~~~typescript
await obligations.start(
  config.slack.botToken,
  (channel, ts) => slack.registerOutboundTs(channel, ts),
);
~~~

The gateway's existing outbound echo cache is reused. Do not move the scheduler or couple the checker to cron/onDispatch.

- [ ] At the beginning of the shutdown body, after the shutdown log and before closing any Slack/Mongo object, insert:

~~~typescript
await obligations.stop();
~~~

This makes further sender calls unavailable and drains those already admitted. Existing shutdown ordering for other components remains intact.

- [ ] Extend the boot-order test with verified source anchors: init and setDeliveryObligations must precede every existing spawn-capable boundary; obligations.start must follow slackAdapter.start; obligations.stop must precede slackAdapter.stop and mongoClient.close. Keep existing worker/scribe anchors and the existing allowlist unchanged; no new pre-boundary .start is introduced.

## Task 13: Instance-bound CLI with no sentinel stamping

**Create:** src/cli/obligations.ts
**Modify:** src/cli.ts
**Test:** src/cli/obligations.test.ts

- [ ] Add this complete command implementation.

~~~typescript
import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { parseArgs } from "node:util";
import { parse as parseYaml } from "yaml";
import dotenv from "dotenv";
import { MongoClient, type Db } from "mongodb";
import { fromKeychain } from "../keychain/from-keychain.js";
import { verifySentinel } from "../db/identity-sentinel.js";
import { guardDb, WriteGuard } from "../db/write-guard.js";
import { ObligationStore } from "../obligations/store.js";
import { ReceiptStore } from "../obligations/receipts.js";
import { ObligationReader } from "../obligations/reader.js";
import { registrationSchema, idSchema, fail, ObligationError } from "../obligations/types.js";
import { adjacent, localDeadline } from "../obligations/deadlines.js";
import { ZodError } from "zod";

export interface CliSelection {
  configPath: string;
  instanceId: string;
  uri: string;
  dbName: string;
}
export function selectInstance(options: { config?: string; instance?: string }, env = process.env): CliSelection {
  if (options.config && options.instance) return fail("choose_config_or_instance");
  let path: string;
  if (options.config) {
    path = resolve(options.config);
    if (existsSync(path) && statSync(path).isDirectory()) path = join(path, "hive.yaml");
  } else if (options.instance) {
    idSchema.parse(options.instance);
    path = resolve(env.HOME ?? "/tmp", "services", "hive", options.instance, "hive.yaml");
  } else if (env.HIVE_HOME) {
    path = resolve(env.HIVE_HOME, env.HIVE_CONFIG ?? "hive.yaml");
  } else {
    return fail("explicit_instance_required");
  }
  if (!existsSync(path)) return fail("config_missing");
  const yaml: unknown = parseYaml(readFileSync(path, "utf8"));
  if (!yaml || typeof yaml !== "object" || !("instance" in yaml)
    || !yaml.instance || typeof yaml.instance !== "object" || !("id" in yaml.instance)
    || typeof yaml.instance.id !== "string") return fail("instance_id_missing");
  const instanceId = idSchema.parse(yaml.instance.id);
  if (options.instance && instanceId !== options.instance) return fail("instance_id_mismatch");
  const suffix = basename(path).match(/^hive-(.+)\.yaml$/)?.[1];
  const envPath = resolve(dirname(path), suffix ? ".env-" + suffix : ".env");
  const fileEnv = existsSync(envPath) ? dotenv.parse(readFileSync(envPath)) : {};
  // Matches config.ts precedence; a sentinel verifies the resulting target.
  const setting = (key: string, fallback: string) =>
    env[key] || fileEnv[key] || fromKeychain(instanceId, key) || fallback;
  return {
    configPath: path, instanceId,
    uri: setting("MONGODB_URI", "mongodb://localhost:27017"),
    dbName: setting("MONGODB_DB", "hive_" + instanceId),
  };
}
export interface CliConnection { db: Db; close(): Promise<void> }
export interface CliDependencies {
  connect(selection: CliSelection): Promise<CliConnection>;
  clock(): Date;
  emit(text: string): void;
}
const defaults: CliDependencies = {
  async connect(selection) {
    const client = new MongoClient(selection.uri, {
      serverSelectionTimeoutMS: 5000, socketTimeoutMS: 10_000,
    });
    try {
      await client.connect();
      return { db: client.db(selection.dbName), close: () => client.close() };
    } catch (err) { await client.close(); throw err; }
  },
  clock: () => new Date(),
  emit: (text) => console.log(text),
};
export async function runObligations(argv: string[], deps: CliDependencies = defaults): Promise<void> {
  try { await executeObligations(argv, deps); }
  catch (err) {
    if (err instanceof ObligationError) throw err;
    if (err instanceof ZodError) throw new ObligationError("invalid_input");
    if (err instanceof SyntaxError) throw new ObligationError("invalid_json");
    throw new ObligationError("command_failed");
  }
}
async function executeObligations(argv: string[], deps: CliDependencies): Promise<void> {
  const parsed = parseArgs({
    args: argv, allowPositionals: true, strict: true,
    options: {
      config: { type: "string" }, instance: { type: "string" },
      file: { type: "string" }, reason: { type: "string" },
      json: { type: "boolean", default: false },
      limit: { type: "string", default: "20" }, cursor: { type: "string" },
    },
  });
  const [command, subcommand, id, extra] = parsed.positionals;
  if (command !== "obligations" || extra) return fail("invalid_command");
  if (!["register", "list", "show", "deactivate"].includes(subcommand ?? "")) return fail("invalid_command");
  if ((subcommand === "register" || subcommand === "list") && id) return fail("unexpected_id");
  if ((subcommand === "show" || subcommand === "deactivate") && !id) return fail("id_required");
  if (id) idSchema.parse(id);
  const limit = Number(parsed.values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) return fail("invalid_limit");
  const input = subcommand === "register"
    ? registrationSchema.parse(JSON.parse(readFileSync(parsed.values.file ?? fail("file_required"), "utf8")))
    : undefined;
  if (subcommand === "deactivate" && !parsed.values.reason?.trim()) return fail("reason_required");
  const selection = selectInstance(parsed.values);
  const connection = await deps.connect(selection);
  try {
    const identity = await verifySentinel(connection.db, {
      instanceId: selection.instanceId, dbName: selection.dbName,
    });
    if (identity.state !== "verified") return fail("identity_unverified");
    const guard = new WriteGuard({ instanceId: selection.instanceId, dbName: selection.dbName });
    const db = guardDb(connection.db, guard);
    const store = new ObligationStore(db);
    // No init() on read paths. Reader discovers the actual existing TTL.
    const receipts = new ReceiptStore(db);
    const reader = new ObligationReader(store, receipts, deps.clock);
    let result: unknown;
    if (subcommand === "register") {
      await store.init();
      const registered = await store.register(input, deps.clock());
      const next = [];
      let after = new Date(Math.max(registered.activeFrom.getTime(), deps.clock().getTime()));
      for (let i = 0; i < 3; i++) {
        after = adjacent(registered.deadline, after, 1);
        if (registered.deactivatedAt && after > registered.deactivatedAt) break;
        next.push({ dueAt: after, local: localDeadline(registered, after) });
      }
      result = { definition: registered, upcoming: next, enrollmentRequired: true };
    } else if (subcommand === "deactivate") {
      const before = await store.get(id!);
      if (!before) return fail("unknown_obligation");
      const outstandingFilter = {
        obligationId: id!,
        $or: [
          { "delivery.state": { $in: ["sending", "unknown"] } },
          { "notice.state": { $in: ["sending", "unknown"] } },
        ],
      };
      const outstanding = await store.occurrencesPage(outstandingFilter, undefined, 100);
      const outstandingCount = await store.occurrences.countDocuments(outstandingFilter);
      const definition = await store.deactivate(id!, parsed.values.reason!, deps.clock());
      result = {
        definition, admission: definition.deliveryAdmission ?? null,
        outstanding: await Promise.all(outstanding.map((o) => reader.occurrenceView(o))),
        outstandingCount, truncated: outstandingCount > outstanding.length,
        policy: "Deadlines at or before the cutoff remain due. Later expectations are cancelled. An attempt admitted before this update may finish; acknowledged evidence is retained. Schedules are unchanged.",
      };
    } else if (subcommand === "list") {
      result = await reader.definitions(undefined, {
        section: "definitions", cursor: parsed.values.cursor, limit,
      });
    } else {
      result = await reader.show(id!, { cursor: parsed.values.cursor, limit });
    }
    deps.emit(JSON.stringify(result, null, parsed.values.json ? undefined : 2));
  } finally {
    await connection.close();
  }
}
~~~

Read commands construct ReceiptStore without a retention configuration and never initialize it; receipt inspection reads the actual existing timestamp TTL.

- [ ] In src/cli.ts help add:

~~~text
  obligations register --file <json>    Register a recurring delivery expectation
  obligations list [--json]             Inspect definitions and checker status
  obligations show <id> [--json]        Inspect occurrence evidence and notices
  obligations deactivate <id> --reason <text>
~~~

- [ ] Add the switch branch:

~~~typescript
case "obligations": {
  try {
    const { runObligations } = await import("./cli/obligations.js");
    await runObligations(process.argv.slice(2));
  } catch (err) {
    console.error(err instanceof Error && /^[a-z_]+$/.test(err.message)
      ? err.message : "obligations_command_failed");
    process.exitCode = 1;
  }
  break;
}
~~~

Global --config resolution must not preload config.ts before this branch. Existing src/cli.ts only sets HIVE_HOME, so the command's explicit path selection remains authoritative and supports a non-default config basename/.env suffix. No ensureIdentitySentinelAtBoot call is allowed here. Pre-connection parsing and selection errors are sanitized by runObligations; the CLI branch prints only bounded code-shaped errors.

## Task 14: Operator documentation

**Create:** docs/delivery-obligations.md

- [ ] Write the following content.

~~~markdown
# Delivery obligations

A delivery obligation records an expectation independently of an agent's cron schedule. Removing a schedule or disabling/removing its producer does not remove an existing expectation.

Enrollment requires two deliberate actions: register a specific deliverable, producer, deadline and delivery/notice destinations; then update that producer's workflow to call the schedule server's deliver_obligation tool for the explicit dueAt key returned by my_delivery_obligations. This feature does not enroll any production deliverable or change prompts.

Use an explicitly selected instance with --instance <id>, --config <path>, or HIVE_HOME. The existing database identity sentinel must match; obligation commands never stamp it.

Example registration file, with fake IDs that must be replaced by operator choices:

{
  "_id": "demo-briefing",
  "deliverable": "Demo complete briefing",
  "producerAgentId": "demo-producer",
  "deadline": { "localTime": "08:00", "weekdays": [1,2,3,4,5], "timezone": "America/Los_Angeles" },
  "destination": { "kind": "slack", "channelId": "C00000001" },
  "noticeDestination": { "kind": "slack", "channelId": "C00000002" },
  "createdBy": "demo-operator"
}

hive obligations register --config /path/to/instance/hive.yaml --file /path/to/definition.json
hive obligations list --instance demo --json
hive obligations show demo-briefing --instance demo --limit 20 --json
hive obligations deactivate demo-briefing --instance demo --reason "Replacement expectation registered"

Registration is idempotent only for an identical immutable definition. To change producer, deadline or recipient, deactivate the old ID and register a new ID. There is no delete/re-enable/resend command. No notice recipient is selected automatically.

Deadlines use the registered IANA timezone. Delivery windows are (previous deadline, deadline], with the first lower bound clamped to registration. No deadline at/before registration is created. A spring clock gap has no occurrence; an autumn fold has two separate UTC occurrence keys. Registration prints upcoming instants with local zone/offset. A late delivery stays attached to its explicit original deadline and does not suppress its missed-deadline notice.

The initial deliverable format is one intentionally complete Slack text post, at most 3,900 characters including engine attribution. The engine does not split, truncate, upload a file, or verify the semantic completeness of linked material. Ordinary Slack posts, hosted Slack MCP output, completed turns and acknowledgements are not proof.

A confirmed delivery requires Slack acknowledgement plus persisted receipt evidence. Delivery receipts are append-only activity history; occurrence checkpoints remain after that history expires. Old acknowledgements remain inspectable with history=expired, without recreating deleted rows. expired_unresolved means the engine cannot prove whether an initial receipt write happened before history retention elapsed.

sending and unknown never mean delivered or notified. Unknown post outcomes are not retried because Slack may already have accepted them. This favors avoiding duplicates and can leave no visible message after an ambiguous crash/timeout. Only documented, verified nonacceptance permits a retry. There is no exactly-once visible-delivery guarantee.

The checker runs independently every 30 seconds and never invokes an agent. A missed-deadline notice says there is no confirmed delivery; it does not assert that Slack definitely received nothing. A late correction is retained without deleting or duplicating the original notice.

Deactivation is prospective: deadlines at/before its cutoff remain due. Later expectations are cancelled. An attempt admitted before the atomic deactivation update may finish and preserve its evidence; a fresh admission after the cutoff is refused. The command reports outstanding attempts. Schedules are unaffected.

Producer discovery uses section=definitions for current keys and section=overdue plus nextCursor for older unresolved keys, including past deadlines of deactivated definitions. Acknowledged/cancelled history and sending/unknown states are non-sendable. list/show are read-only and never materialize a deadline, repair a receipt, or send a notice. JSON dates are UTC. receiptRetentionMs reports the observed timestamp TTL in milliseconds. The heartbeat reports unfinished materialization, evaluation, admission and receipt-recovery work units, including future/cancelled evidence repair. It reports backlog while work remains and becomes unknown when its last successful sweep is older than 120 seconds.
~~~

- [ ] Run the CLI/provider/containment/boot commands from the main Testing Contract, then npm run typecheck and git diff --check. Commit verified wiring and docs:

~~~bash
git add src/obligations/runtime.ts src/obligations/receipts.ts src/schedule/schedule-mcp-server.ts src/agents/agent-runner.ts src/agents/agent-manager.ts src/index.ts src/cli.ts src/cli/obligations.ts docs/delivery-obligations.md src/cli/obligations.test.ts src/schedule/schedule-mcp-server.test.ts src/agents/provider-adapters/tool-bridge.test.ts src/agents/agent-runner.test.ts src/agents/agent-manager.test.ts src/boot-order.test.ts
git commit -m "feat: expose delivery obligations through provider tools and instance CLI"
~~~
