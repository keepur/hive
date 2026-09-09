import type { WebClientOptions } from "@slack/web-api";
import type { Db } from "mongodb";
import { AgentRegistry } from "../../agents/agent-registry.js";
import type { AgentManager, TurnResult } from "../../agents/agent-manager.js";
import { Dispatcher } from "../../channels/dispatcher.js";
import { SlackAdapter } from "../../channels/slack-adapter.js";
import { guardDb, WriteGuard } from "../../db/write-guard.js";
import type { HealthReporter } from "../../health/health-reporter.js";
import { SlackGateway } from "../../slack/slack-gateway.js";
import type { AgentDefinition } from "../../types/agent-definition.js";
import type { WorkItem } from "../../types/work-item.js";
import { buildAdminTools } from "../admin-mcp-server.js";
import { ModelCatalogNotifier } from "../model-catalog-notifier.js";
import { ModelCatalogOutbox } from "../model-catalog-outbox.js";
import { ModelCatalogScanner } from "../model-catalog-scanner.js";
import { ModelCatalogStore } from "../model-catalog-store.js";
import type { CatalogProvider, DiscoveredModel } from "../model-catalog-types.js";
import { startStandaloneMongo } from "./standalone-mongo.js";

type NoticeFetch = NonNullable<WebClientOptions["fetch"]>;

export interface CatalogNotificationHarness {
  db: Db;
  store: ModelCatalogStore;
  scanner: ModelCatalogScanner;
  outbox: ModelCatalogOutbox;
  notifier: ModelCatalogNotifier;
  dispatcher: Dispatcher;
  registry: AgentRegistry;
  manual(input: {
    provider: string;
    models: { id: string; displayName: string; notes?: string }[];
    changeSummary?: string;
  }): Promise<unknown>;
  setNow(at: Date): void;
  posts: { channel: string; text: string; returned: unknown }[];
  turns: { agentId: string; workItem: WorkItem }[];
  close(): Promise<void>;
}

export interface CatalogSlackRequest {
  kind: "auth" | "channels" | "post";
  url: string;
  method: string;
  body: URLSearchParams;
  ordinal: number;
}

export interface CatalogNotificationHarnessOptions {
  /** Reuse an owned database for restart schedules. The caller then closes its owner. */
  db?: Db;
  /** Install the same recording fetch into a test-scoped real WebClient wrapper. */
  installExternalFetch?: (fetch: NoticeFetch) => void;
  slack?: (request: CatalogSlackRequest) => Response | Promise<Response>;
  discover?: (provider: CatalogProvider, options: { signal: AbortSignal }) => Promise<DiscoveredModel[]>;
  turn?: (agentId: string, workItem: WorkItem) => Promise<TurnResult>;
  /** Step 8B supplies its real manager after this fixture creates the shared registry and guarded Db. */
  createAgentManager?: (context: { db: Db; registry: AgentRegistry }) => AgentManager | Promise<AgentManager>;
  initialNow?: Date;
  seedAgent?: boolean;
  agent?: Partial<AgentDefinition>;
  scanner?: {
    scanIntervalMs?: number;
    maintenanceIntervalMs?: number;
    leaseMs?: number;
    drainMs?: number;
  };
  notifier?: {
    pollMs?: number;
    leaseMs?: number;
    renewMs?: number;
    drainMs?: number;
    batch?: number;
  };
}

export type OwnedCatalogNotificationMongo = Awaited<ReturnType<typeof startStandaloneMongo>>;

export function startCatalogNotificationMongo(): Promise<OwnedCatalogNotificationMongo> {
  return startStandaloneMongo();
}

export const DEFAULT_DISCOVERY: Readonly<Record<CatalogProvider, readonly DiscoveredModel[]>> = {
  claude: [{ id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" }],
  codex: [{ id: "gpt-5.4", displayName: "GPT-5.4" }],
  grok: [{ id: "grok-4.20", displayName: "Grok 4.20" }],
};

export function makeCatalogAgent(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  const at = new Date("2026-01-01T00:00:00.000Z");
  return {
    _id: "chief-of-staff",
    name: "Chief of Staff",
    aliases: [],
    roles: ["Chief of Staff"],
    icon: ":bee:",
    model: "haiku",
    channels: ["CNOTICE1"],
    homeBase: "CNOTICE1",
    passiveChannels: [],
    keywords: [],
    isDefault: true,
    coreServers: [],
    delegateServers: [],
    delegatePrompts: {},
    soul: "",
    systemPrompt: "",
    schedule: [],
    budgetUsd: 10,
    maxTurns: 200,
    maxConcurrent: 3,
    spawnBudget: 5,
    timeoutMs: 300_000,
    effort: "low",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    disabled: false,
    createdAt: at,
    updatedAt: at,
    updatedBy: "catalog-notification-e2e",
    ...overrides,
  };
}

export function makeCatalogTurnResult(text = "I will bring any proposal to the operator."): TurnResult {
  return {
    finalMessage: text,
    newSessionId: "catalog-notification-session",
    usage: {
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 200_000,
      costUsd: 0.01,
      durationMs: 20,
    },
    errors: [],
    llmMs: 15,
    toolMs: 0,
    toolCalls: 0,
    toolSummary: null,
    toolAckInjected: 0,
    streamed: false,
    compactions: 0,
  };
}

function json(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function deterministicUuid() {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-4000-8000-${String(next).padStart(12, "0")}`;
  };
}

function poison<T extends object>(label: string): T {
  return new Proxy(
    {},
    {
      get: (_target, property) => {
        throw new Error(`${label}.${String(property)} unexpectedly used by catalog notification E2E`);
      },
    },
  ) as T;
}

export async function createCatalogNotificationHarness(
  options: CatalogNotificationHarnessOptions = {},
): Promise<CatalogNotificationHarness> {
  const owned = options.db ? undefined : await startStandaloneMongo();
  const rawDb = options.db ?? owned!.db;
  const guard = new WriteGuard({ instanceId: "catalog-notification-e2e", dbName: rawDb.databaseName });
  const db = guardDb(rawDb, guard);
  const posts: CatalogNotificationHarness["posts"] = [];
  const turns: CatalogNotificationHarness["turns"] = [];
  const uuid = deterministicUuid();
  let pinnedNow = options.initialNow ? new Date(options.initialNow) : undefined;
  const currentNow = () => new Date(pinnedNow ?? new Date());
  let requestOrdinal = 0;

  const fetch: NoticeFetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (method !== "POST") throw new Error(`Unexpected Slack method ${method} for ${url}`);
    const body = new URLSearchParams(typeof init?.body === "string" ? init.body : "");
    let kind: CatalogSlackRequest["kind"];
    if (url === "https://slack.com/api/auth.test") kind = "auth";
    else if (url === "https://slack.com/api/conversations.list") kind = "channels";
    else if (url === "https://slack.com/api/chat.postMessage") kind = "post";
    else throw new Error(`Unexpected Slack URL ${url}`);

    const request = { kind, url, method, body, ordinal: ++requestOrdinal };
    const posted =
      kind === "post"
        ? {
            channel: body.get("channel") ?? "",
            text: body.get("text") ?? "",
            returned: undefined as unknown,
          }
        : undefined;
    if (posted) posts.push(posted);

    try {
      const response = options.slack
        ? await options.slack(request)
        : kind === "auth"
          ? json({ ok: true, user_id: "UCATALOGTEST", bot_id: "BCATALOGTEST" })
          : kind === "channels"
            ? json({
                ok: true,
                channels: [{ id: "CNOTICE1", name: "catalog-notices" }],
                response_metadata: { next_cursor: "" },
              })
            : json({
                ok: true,
                channel: posted!.channel,
                ts: `1900000000.${String(posts.length).padStart(6, "0")}`,
              });
      if (posted) {
        const clone = response.clone();
        posted.returned = await clone.json().catch(() => clone.text().catch(() => undefined));
      }
      return response;
    } catch (error) {
      if (posted) posted.returned = { threw: error instanceof Error ? error.message : String(error) };
      throw error;
    }
  };
  options.installExternalFetch?.(fetch);

  const fixture = makeCatalogAgent(options.agent);
  if (options.seedAgent !== false) {
    const existing = await db.collection<AgentDefinition>("agent_definitions").findOne({ _id: fixture._id });
    if (!existing) await db.collection<AgentDefinition>("agent_definitions").insertOne(fixture);
  }
  const registry = new AgentRegistry(db.collection<AgentDefinition>("agent_definitions"));
  await registry.load();

  const store = new ModelCatalogStore(db, {
    listPluginProviderIds: () => ["sol"],
    now: currentNow,
    uuid,
  });
  const discover =
    options.discover ??
    (async (provider: CatalogProvider) => DEFAULT_DISCOVERY[provider].map((model) => ({ ...model })));
  const scanner = new ModelCatalogScanner(store, discover, {
    now: () => currentNow().getTime(),
    uuid,
    ...options.scanner,
  });

  const manager = options.createAgentManager
    ? await options.createAgentManager({ db, registry })
    : (new Proxy(
        {
          runWorkItemTurn: async (agentId: string, workItem: WorkItem) => {
            turns.push({ agentId, workItem });
            return options.turn?.(agentId, workItem) ?? makeCatalogTurnResult();
          },
        },
        {
          get: (target, property) => {
            if (property === "runWorkItemTurn") return target.runWorkItemTurn;
            throw new Error(`agentManager.${String(property)} unexpectedly used by catalog notification E2E`);
          },
        },
      ) as unknown as AgentManager);
  const dispatcher = new Dispatcher(registry, manager, poison<HealthReporter>("healthReporter"), "chief-of-staff");
  const gateway = new SlackGateway("xapp-catalog-test", "xoxb-catalog-test", { fetch });
  const adapter = new SlackAdapter(gateway, registry);
  await adapter.start(() => {
    throw new Error("Inbound generic Slack routing unexpectedly reached catalog notification E2E");
  });
  dispatcher.registerAdapter(adapter);
  dispatcher.setSlackAdapter(adapter);
  dispatcher.setCatalogNotificationDefault("chief-of-staff");
  dispatcher.setRetryQueue(poison<Parameters<Dispatcher["setRetryQueue"]>[0]>("genericRetryQueue"));
  dispatcher.setOutageStateProvider(() => {
    throw new Error("Generic outage routing unexpectedly used by catalog notification E2E");
  });
  dispatcher.setAuditChannel(
    poison<Parameters<Dispatcher["setAuditChannel"]>[0]>("genericAuditAdapter"),
    new Map(),
    "CAUDITPOISON",
  );

  const outbox = new ModelCatalogOutbox(db);
  const notifier = new ModelCatalogNotifier(outbox, dispatcher, {
    now: currentNow,
    uuid,
    ...options.notifier,
  });

  type TestTool = { name: string; handler?: (input: unknown) => Promise<unknown> };
  const tools = buildAdminTools({
    db,
    agentId: "test-operator",
    instanceCapabilitiesJson: "{}",
    listPluginProviderIds: () => ["sol"],
  }) as unknown as TestTool[];
  const refresh = tools.find((tool) => tool.name === "agent_model_catalog_refresh")?.handler;
  if (!refresh) throw new Error("SDK tool shim did not expose agent_model_catalog_refresh.handler");

  let closed = false;
  return {
    db,
    store,
    scanner,
    outbox,
    notifier,
    dispatcher,
    registry,
    manual: (input) => refresh(input),
    setNow: (at) => {
      if (!(at instanceof Date) || !Number.isFinite(at.getTime())) throw new Error("Invalid harness clock");
      pinnedNow = new Date(at);
    },
    posts,
    turns,
    close: async () => {
      if (closed) return;
      closed = true;
      const stopped = await Promise.allSettled([scanner.stop(), notifier.stop(), adapter.stop()]);
      registry.stopWatching();
      const failed = stopped.find((result): result is PromiseRejectedResult => result.status === "rejected");
      try {
        if (failed) throw failed.reason;
      } finally {
        await owned?.close();
      }
    },
  };
}
