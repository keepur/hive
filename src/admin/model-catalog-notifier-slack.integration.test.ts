import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { WebClientOptions } from "@slack/web-api";
import type { Db } from "mongodb";

const testLog = vi.hoisted(() => ({
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}));
vi.mock("../logging/logger.js", () => ({ createLogger: () => testLog }));

const socket = vi.hoisted(() => ({
  start: vi.fn().mockResolvedValue(undefined),
  disconnect: vi.fn().mockResolvedValue(undefined),
  on: vi.fn(),
}));
vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: vi.fn().mockImplementation(function () {
    return { on: socket.on, start: socket.start, disconnect: socket.disconnect };
  }),
}));

import type { AgentManager, TurnResult } from "../agents/agent-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import { Dispatcher } from "../channels/dispatcher.js";
import { SlackAdapter } from "../channels/slack-adapter.js";
import type { HealthReporter } from "../health/health-reporter.js";
import { SlackGateway } from "../slack/slack-gateway.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { WorkItem } from "../types/work-item.js";
import { JOURNALED } from "./model-catalog-export.js";
import { MAX_NOTICE_DATE_MS, makePreparation, preparationId, type NoticeRoute } from "./model-catalog-notification.js";
import { ModelCatalogNotifier } from "./model-catalog-notifier.js";
import { copy, ModelCatalogOutbox, transition } from "./model-catalog-outbox.js";
import type { CatalogChangeDoc } from "./model-catalog-types.js";
import { deferred, faultDb } from "./testing/catalog-db.test-support.js";
import { startStandaloneMongo } from "./testing/standalone-mongo.js";

const CHANGES = "agent_model_catalog_changes";
const NOTICE_TEXT = "Reviewed the physical catalog change.";
type NoticeFetch = NonNullable<WebClientOptions["fetch"]>;
type FetchCall = { url: string; init: Parameters<NoticeFetch>[1] };

let mongo: Awaited<ReturnType<typeof startStandaloneMongo>>;

function rawResponse(body: string, status = 200, headers?: HeadersInit): Response {
  return new Response(body, { status, headers });
}

function heldFetch() {
  const entered = deferred<void>();
  const release = deferred<Response>();
  const calls: FetchCall[] = [];
  const fetch: NoticeFetch = async (url, init) => {
    calls.push({ url: String(url), init });
    entered.resolve();
    return release.promise;
  };
  return { fetch, calls, entered, release };
}

function recordingFetch(makeResponse: (call: FetchCall) => Response | Promise<Response>) {
  const calls: FetchCall[] = [];
  const fetch: NoticeFetch = async (url, init) => {
    const call = { url: String(url), init };
    calls.push(call);
    return makeResponse(call);
  };
  return { fetch, calls };
}

function makeAgent(homeBase = "CNOTICE"): AgentConfig {
  return {
    id: "chief-of-staff",
    name: "Chief of Staff",
    aliases: [],
    roles: [],
    model: "claude/claude-sonnet-4-6",
    channels: [homeBase],
    homeBase,
    passiveChannels: [],
    keywords: [],
    isDefault: true,
    schedule: [],
    budgetUsd: 5,
    maxTurns: 20,
    icon: ":bee:",
    coreServers: [],
    delegateServers: [],
    soul: "",
    systemPrompt: "",
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
  };
}

function turnResult(): TurnResult {
  return {
    finalMessage: NOTICE_TEXT,
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
    streamed: false,
    compactions: 0,
  };
}

function makeManager() {
  return {
    runWorkItemTurn: vi.fn(async (_agentId: string, _item: WorkItem): Promise<TurnResult> => turnResult()),
  };
}

function makeRegistry(agent: AgentConfig) {
  return {
    getAll: vi.fn(() => [agent]),
    get: vi.fn((id: string) => (id === agent.id ? agent : undefined)),
    findByChannel: vi.fn(() => undefined),
  };
}

function uuidSequence(prefix: string) {
  let value = 0;
  return () => `${prefix}-${++value}`;
}

function change(number: number, now = new Date()): CatalogChangeDoc {
  return {
    _id: `physical-slack-${String(number).padStart(3, "0")}`,
    provider: "codex",
    revision: number,
    snapshotId: `physical-snapshot-${number}`,
    createdAt: new Date(now.getTime() - 120_000 + number),
    source: "manual",
    updatedBy: "physical-integration-operator",
    modelCount: 2,
    bootstrap: false,
    added: [`physical-model-${number}`],
    removed: ["physical-old-model"],
    delivery: { state: "pending", attempts: 0, nextAttemptAt: new Date(now.getTime() - 60_000) },
  };
}

function preparedChange(number: number, now: Date, homeBase: string) {
  const row = change(number, now);
  const route: NoticeRoute = {
    agentId: "chief-of-staff",
    agentName: "Chief of Staff",
    homeBase,
    adapterId: "slack",
    channelId: "CNOTICE",
  };
  const preparation = makePreparation(row, route, "Previously persisted catalog notice.", new Date(now.getTime() - 1));
  row.delivery = { ...row.delivery, preparation, uncertainSend: true };
  return { row, preparation };
}

async function seed(row: CatalogChangeDoc): Promise<void> {
  await mongo.db.collection<CatalogChangeDoc>(CHANGES).insertOne(copy(row), JOURNALED);
}

async function stored(id: string): Promise<CatalogChangeDoc> {
  const row = await mongo.db.collection<CatalogChangeDoc>(CHANGES).findOne({ _id: id });
  if (!row) throw new Error("missing physical Slack integration fixture");
  return row;
}

async function makeDue(id: string): Promise<CatalogChangeDoc> {
  const before = await stored(id);
  const delivery = {
    ...copy(before.delivery),
    nextAttemptAt: new Date(Date.now() - 1_000),
    version: (before.delivery.version ?? 0) + 1,
  };
  // Task 8 fixture convention: exact-version, journaled due-time advancement only.
  const result = await mongo.db
    .collection<CatalogChangeDoc>(CHANGES)
    .updateOne(
      { _id: id, "delivery.state": "pending", "delivery.version": before.delivery.version },
      { $set: { delivery } },
      { ...JOURNALED, upsert: false },
    );
  expect(result.acknowledged).toBe(true);
  expect(result.matchedCount).toBe(1);
  return stored(id);
}

async function serverNow(): Promise<Date> {
  return (await mongo.db.admin().command({ hello: 1 })).localTime as Date;
}

async function waitForServerAfter(deadline: Date): Promise<void> {
  const limit = Date.now() + 2_000;
  for (;;) {
    if ((await serverNow()) > deadline) return;
    if (Date.now() >= limit) throw new Error("standalone Mongo clock did not pass the notification lease");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function requestText(call: FetchCall): string | null {
  return new URLSearchParams(call.init?.body as string).get("text");
}

interface ChainOptions {
  agent?: AgentConfig;
  manager?: ReturnType<typeof makeManager>;
  now?: () => Date;
  leaseMs?: number;
  drainMs?: number;
  db?: Db;
  uuidPrefix?: string;
}

async function makeChain(fetch: NoticeFetch, options: ChainOptions = {}) {
  const agent = options.agent ?? makeAgent();
  const registry = makeRegistry(agent);
  const manager = options.manager ?? makeManager();
  const gateway = new SlackGateway("xapp-physical-test", "xoxb-physical-test", { fetch });
  const auth = vi.spyOn(gateway.client.auth, "test").mockResolvedValue({
    ok: true,
    user_id: "UPHYSICAL",
    bot_id: "BPHYSICAL",
  });
  const adapter = new SlackAdapter(gateway, registry as unknown as AgentRegistry);
  await adapter.start(() => undefined);
  const dispatcher = new Dispatcher(
    registry as unknown as AgentRegistry,
    manager as unknown as AgentManager,
    {} as HealthReporter,
    "unused-default",
  );
  dispatcher.setSlackAdapter(adapter);
  const outbox = new ModelCatalogOutbox(options.db ?? mongo.db);
  const notifier = new ModelCatalogNotifier(outbox, dispatcher, {
    uuid: uuidSequence(options.uuidPrefix ?? "physical"),
    ...(options.now ? { now: options.now } : {}),
    ...(options.leaseMs ? { leaseMs: options.leaseMs } : {}),
    ...(options.drainMs ? { drainMs: options.drainMs } : {}),
  });
  let adapterStopped = false;
  let closed = false;
  const stopAdapter = async () => {
    if (adapterStopped) return;
    adapterStopped = true;
    await adapter.stop();
  };
  const close = async () => {
    if (closed) return;
    closed = true;
    await notifier.stop();
    await stopAdapter();
    auth.mockRestore();
  };
  return { agent, registry, manager, gateway, adapter, dispatcher, outbox, notifier, stopAdapter, close };
}

const malformedCases = [
  { label: "invalid JSON error text", status: 200, body: "channel_not_found" },
  { label: "truncated JSON", status: 200, body: '{"ok":false' },
  { label: "array error", status: 200, body: '{"ok":false,"error":["channel_not_found"]}' },
  { label: "object error", status: 200, body: '{"ok":false,"error":{"code":"channel_not_found"}}' },
  { label: "number error", status: 200, body: '{"ok":false,"error":4}' },
  { label: "null error", status: 200, body: '{"ok":false,"error":null}' },
  { label: "missing ok", status: 200, body: '{"error":"channel_not_found"}' },
  { label: "nonboolean ok", status: 200, body: '{"ok":"false","error":"channel_not_found"}' },
  {
    label: "null response metadata",
    status: 200,
    body: '{"ok":false,"error":"channel_not_found","response_metadata":null}',
  },
  {
    label: "array response metadata",
    status: 200,
    body: '{"ok":false,"error":"channel_not_found","response_metadata":[]}',
  },
  {
    label: "string response metadata delay",
    status: 200,
    body: '{"ok":false,"error":"channel_not_found","response_metadata":{"retryAfter":"120"}}',
  },
  {
    label: "negative response metadata delay",
    status: 200,
    body: '{"ok":false,"error":"channel_not_found","response_metadata":{"retryAfter":-1}}',
  },
  { label: "junk 429 Retry-After", status: 429, body: "rate limited", retryAfter: "120junk" },
  { label: "negative 429 Retry-After", status: 429, body: "rate limited", retryAfter: "-1" },
  { label: "fractional 429 Retry-After", status: 429, body: "rate limited", retryAfter: "1.5" },
  { label: "exponent 429 Retry-After", status: 429, body: "rate limited", retryAfter: "1e2" },
  { label: "empty 429 Retry-After", status: 429, body: "rate limited", retryAfter: "" },
  { label: "missing 429 Retry-After", status: 429, body: "rate limited" },
  { label: "nonfinite 429 Retry-After", status: 429, body: "rate limited", retryAfter: "9".repeat(400) },
  {
    label: "allowlisted 200 refusal with malformed Retry-After",
    status: 200,
    body: '{"ok":false,"error":"channel_not_found"}',
    retryAfter: "120junk",
  },
  { label: "internal_error", status: 200, body: '{"ok":false,"error":"internal_error"}' },
  { label: "fatal_error", status: 200, body: '{"ok":false,"error":"fatal_error"}' },
  { label: "future API error", status: 200, body: '{"ok":false,"error":"future_catalog_error"}' },
] as const;

beforeAll(async () => {
  mongo = await startStandaloneMongo();
}, 30_000);

afterAll(async () => {
  await mongo?.close();
}, 30_000);

beforeEach(async () => {
  expect(mongo.db.databaseName).toMatch(/^hive_kpr459_test_/);
  await mongo.db.dropDatabase();
  vi.clearAllMocks();
}, 30_000);

describe("physical Slack SDK catalog notification chain", () => {
  it.each(malformedCases)(
    "keeps $label uncertain through gateway, dispatcher, notifier, and restart",
    async ({ status, body, ...fixture }) => {
      const row = change(100);
      await seed(row);
      const manager = makeManager();
      const firstTransport = heldFetch();
      let first: Awaited<ReturnType<typeof makeChain>> | undefined;
      let restarted: Awaited<ReturnType<typeof makeChain>> | undefined;
      try {
        first = await makeChain(firstTransport.fetch, { manager, uuidPrefix: "malformed-first" });
        const flight = first.notifier.tick();
        await firstTransport.entered.promise;

        const sending = await stored(row._id);
        const preparation = copy(sending.delivery.preparation!);
        expect(preparation.text).toContain(`CoS response (quoted data): "${NOTICE_TEXT}"`);
        expect(preparation.id).toBe(
          preparationId(row._id, {
            binding: preparation.binding,
            processedAt: preparation.processedAt,
            text: preparation.text,
          }),
        );
        expect(sending.delivery).toMatchObject({
          state: "claimed",
          preparation,
          claim: {
            stage: "sending",
            sendIntent: {
              preparationId: preparation.id,
              startedAt: expect.any(Date),
              previouslyUncertain: false,
            },
          },
        });
        expect(sending.delivery.receipt).toBeUndefined();
        expect(firstTransport.calls).toHaveLength(1);
        expect(firstTransport.calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
        expect(requestText(firstTransport.calls[0]!)).toBe(preparation.text);

        const retryAfter = "retryAfter" in fixture ? fixture.retryAfter : undefined;
        firstTransport.release.resolve(
          rawResponse(body, status, retryAfter === undefined ? undefined : { "Retry-After": retryAfter }),
        );
        await flight;

        const pending = await stored(row._id);
        expect(pending.delivery).toMatchObject({
          state: "pending",
          preparation,
          uncertainSend: true,
          diagnostic: { reason: "delivery-unconfirmed" },
        });
        expect(pending.delivery.claim).toBeUndefined();
        expect(pending.delivery.receipt).toBeUndefined();
        expect(pending.delivery.retryBlocked).toBeUndefined();
        expect(firstTransport.calls).toHaveLength(1);
        expect(manager.runWorkItemTurn).toHaveBeenCalledTimes(1);
        await first.close();
        first = undefined;

        await makeDue(row._id);
        const acceptedTransport = recordingFetch(() =>
          rawResponse('{"ok":true,"channel":"CNOTICE","ts":"1880000000.000001"}'),
        );
        restarted = await makeChain(acceptedTransport.fetch, {
          manager,
          uuidPrefix: "malformed-restarted",
        });
        await restarted.notifier.tick();

        const delivered = await stored(row._id);
        expect(manager.runWorkItemTurn).toHaveBeenCalledTimes(1);
        expect(acceptedTransport.calls).toHaveLength(1);
        expect(acceptedTransport.calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
        expect(requestText(acceptedTransport.calls[0]!)).toBe(preparation.text);
        expect(delivered.delivery).toMatchObject({
          state: "delivered",
          preparation,
          uncertainSend: true,
          receipt: {
            preparationId: preparation.id,
            binding: preparation.binding,
            channelId: "CNOTICE",
            messageTs: "1880000000.000001",
          },
        });
      } finally {
        firstTransport.release.resolve(rawResponse('{"ok":false,"error":"internal_error"}'));
        await first?.close();
        await restarted?.close();
      }
    },
  );

  it.each([
    {
      label: "allowlisted JSON refusal",
      response: rawResponse('{"ok":false,"error":"channel_not_found"}'),
      retryMs: 60_000,
    },
    {
      label: "valid HTTP 429",
      response: rawResponse("rate limited", 429, { "Retry-After": "120" }),
      retryMs: 120_000,
    },
  ])("clears only the current intent for a $label and retains prior uncertainty", async ({ response, retryMs }) => {
    const now = new Date(Math.floor((await serverNow()).getTime() / 1_000) * 1_000);
    const row = change(200, now);
    row.delivery.uncertainSend = true;
    await seed(row);
    const manager = makeManager();
    const transport = heldFetch();
    let chain: Awaited<ReturnType<typeof makeChain>> | undefined;
    try {
      chain = await makeChain(transport.fetch, {
        manager,
        now: () => new Date(now),
        uuidPrefix: "definite-refusal",
      });
      const flight = chain.notifier.tick();
      await transport.entered.promise;

      const sending = await stored(row._id);
      const preparation = copy(sending.delivery.preparation!);
      expect(sending.delivery).toMatchObject({
        state: "claimed",
        uncertainSend: true,
        preparation,
        claim: {
          stage: "sending",
          sendIntent: {
            preparationId: preparation.id,
            previouslyUncertain: true,
          },
        },
      });

      transport.release.resolve(response);
      await flight;

      const pending = await stored(row._id);
      expect(pending.delivery).toMatchObject({
        state: "pending",
        uncertainSend: true,
        preparation,
        nextAttemptAt: new Date(now.getTime() + retryMs),
        diagnostic: { reason: "delivery-unconfirmed", at: now },
      });
      expect(pending.delivery.claim).toBeUndefined();
      expect(pending.delivery.receipt).toBeUndefined();
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]?.url).toBe("https://slack.com/api/chat.postMessage");
      expect(requestText(transport.calls[0]!)).toBe(preparation.text);
      expect(manager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    } finally {
      transport.release.resolve(rawResponse('{"ok":false,"error":"channel_not_found"}'));
      await chain?.close();
    }
  });

  it.each([
    {
      label: "post delay at maximum Date equality",
      path: "post" as const,
      header: (now: Date) => String((MAX_NOTICE_DATE_MS - now.getTime()) / 1_000),
      blocked: false,
    },
    {
      label: "lookup delay one second beyond maximum Date",
      path: "lookup" as const,
      header: (now: Date) => String((MAX_NOTICE_DATE_MS - now.getTime()) / 1_000 + 1),
      blocked: true,
    },
    {
      label: "post delay of nine trillion seconds",
      path: "post" as const,
      header: () => "9000000000000",
      blocked: true,
    },
    {
      label: "lookup delay whose millisecond conversion is unsafe",
      path: "lookup" as const,
      header: () => "9007199254741",
      blocked: true,
    },
  ])("persists a physical rate-limit $label without an early retry", async ({ path, header, blocked }) => {
    const now = new Date(Math.floor((await serverNow()).getTime() / 1_000) * 1_000);
    const homeBase = path === "lookup" ? "catalog-notices" : "CNOTICE";
    const { row, preparation } = preparedChange(300, now, homeBase);
    await seed(row);
    const manager = makeManager();
    const transport = recordingFetch(() => rawResponse("rate limited", 429, { "Retry-After": header(now) }));
    let chain: Awaited<ReturnType<typeof makeChain>> | undefined;
    let restarted: Awaited<ReturnType<typeof makeChain>> | undefined;
    try {
      chain = await makeChain(transport.fetch, {
        agent: makeAgent(homeBase),
        manager,
        now: () => new Date(now),
        uuidPrefix: `deadline-${path}`,
      });

      await expect(chain.notifier.tick()).resolves.toBeUndefined();

      const pending = await stored(row._id);
      expect(pending.delivery).toMatchObject({
        state: "pending",
        attempts: 1,
        preparation,
        uncertainSend: true,
        ...(blocked
          ? {
              retryBlocked: true,
              nextAttemptAt: now,
              diagnostic: { reason: "retry-deadline-unrepresentable", at: now },
            }
          : {
              nextAttemptAt: new Date(MAX_NOTICE_DATE_MS),
              diagnostic: { reason: "delivery-unconfirmed", at: now },
            }),
      });
      expect(pending.delivery.receipt).toBeUndefined();
      expect(pending.delivery.claim).toBeUndefined();
      expect(pending.delivery.retryBlocked).toBe(blocked ? true : undefined);
      expect(transport.calls).toHaveLength(1);
      expect(transport.calls[0]?.url).toBe(
        path === "lookup" ? "https://slack.com/api/conversations.list" : "https://slack.com/api/chat.postMessage",
      );
      if (path === "post") expect(requestText(transport.calls[0]!)).toBe(preparation.text);
      expect(manager.runWorkItemTurn).not.toHaveBeenCalled();
      await chain.close();
      chain = undefined;

      const unexpected = recordingFetch(() => {
        throw new Error("blocked or future retry started a Slack request");
      });
      const restartNow = blocked ? new Date(now.getTime() + 86_400_000) : new Date(MAX_NOTICE_DATE_MS - 1);
      restarted = await makeChain(unexpected.fetch, {
        agent: makeAgent(homeBase),
        manager,
        now: () => new Date(restartNow),
        uuidPrefix: `deadline-restarted-${path}`,
      });
      await expect(restarted.notifier.tick()).resolves.toBeUndefined();
      expect(await stored(row._id)).toEqual(pending);
      expect(unexpected.calls).toHaveLength(0);
      expect(manager.runWorkItemTurn).not.toHaveBeenCalled();
    } finally {
      await chain?.close();
      await restarted?.close();
    }
  });

  it.each(["notifier stop", "adapter stop", "lease expiry", "successor takeover"] as const)(
    "starts no second physical lookup, turn, or post after %s",
    async (mode) => {
      const row = change(400);
      await seed(row);
      const manager = makeManager();
      const transport = heldFetch();
      let chain: Awaited<ReturnType<typeof makeChain>> | undefined;
      try {
        chain = await makeChain(transport.fetch, {
          agent: makeAgent("catalog-notices"),
          manager,
          leaseMs: 100,
          drainMs: 20,
          uuidPrefix: "held-page",
        });
        const reads = vi.spyOn(chain.outbox, "read");
        const applies = vi.spyOn(chain.outbox, "apply");
        const flight = chain.notifier.tick();
        await transport.entered.promise;

        const claimed = await stored(row._id);
        expect(claimed.delivery).toMatchObject({
          state: "claimed",
          attempts: 1,
          claim: { stage: "preparing", leaseExpiresAt: expect.any(Date) },
        });
        let callsAtDrain: number | undefined;
        if (mode === "notifier stop") {
          await chain.notifier.stop();
          callsAtDrain = reads.mock.calls.length + applies.mock.calls.length;
        } else if (mode === "adapter stop") {
          await chain.stopAdapter();
        } else {
          await waitForServerAfter(claimed.delivery.claim!.leaseExpiresAt);
          if (mode === "successor takeover") {
            const observed = await stored(row._id);
            const at = await serverNow();
            const current = copy(observed.delivery);
            const successor = transition(
              "claim",
              observed,
              {
                ...current,
                state: "claimed",
                attempts: current.attempts + 1,
                lastAttemptAt: at,
                uncertainSend: Boolean(current.uncertainSend || current.claim?.sendIntent),
                claim: {
                  token: "held-page-successor-token",
                  owner: "held-page-successor",
                  startedAt: at,
                  leaseExpiresAt: new Date(at.getTime() + 10_000),
                  stage: "preparing",
                },
              },
              at,
              false,
            );
            await expect(new ModelCatalogOutbox(mongo.db).apply(successor)).resolves.toMatchObject({
              kind: "applied",
              source: "ack",
            });
          }
        }

        transport.release.resolve(
          rawResponse(
            JSON.stringify({
              ok: true,
              channels: [],
              response_metadata: { next_cursor: "held-next-page" },
            }),
          ),
        );
        await flight;

        expect(transport.calls).toHaveLength(1);
        expect(transport.calls[0]?.url).toBe("https://slack.com/api/conversations.list");
        expect(manager.runWorkItemTurn).not.toHaveBeenCalled();
        if (callsAtDrain !== undefined) {
          expect(reads.mock.calls.length + applies.mock.calls.length).toBe(callsAtDrain);
        }
      } finally {
        transport.release.resolve(
          rawResponse('{"ok":true,"channels":[],"response_metadata":{"next_cursor":"held-next-page"}}'),
        );
        await chain?.close();
      }
    },
  );

  it("starts no Slack request or later store operation when the lookup ownership read resumes after drain", async () => {
    const row = change(500);
    await seed(row);
    const entered = deferred<void>();
    const resume = deferred<void>();
    let readCount = 0;
    const gatedDb = faultDb(mongo.db, async (collection, method, _args, run) => {
      if (collection === CHANGES && method === "findOne" && ++readCount === 2) {
        entered.resolve();
        await resume.promise;
      }
      return run();
    });
    const manager = makeManager();
    const transport = recordingFetch(() => {
      throw new Error("lookup request started after its ownership read was stopped");
    });
    let chain: Awaited<ReturnType<typeof makeChain>> | undefined;
    try {
      chain = await makeChain(transport.fetch, {
        agent: makeAgent("catalog-notices"),
        manager,
        db: gatedDb,
        drainMs: 20,
        uuidPrefix: "held-gate-read",
      });
      const reads = vi.spyOn(chain.outbox, "read");
      const applies = vi.spyOn(chain.outbox, "apply");
      const flight = chain.notifier.tick();
      await entered.promise;

      await chain.notifier.stop();
      const callsAtDrain = reads.mock.calls.length + applies.mock.calls.length;
      resume.resolve();
      await flight;

      expect(reads.mock.calls.length + applies.mock.calls.length).toBe(callsAtDrain);
      expect(transport.calls).toHaveLength(0);
      expect(manager.runWorkItemTurn).not.toHaveBeenCalled();
    } finally {
      resume.resolve();
      await chain?.close();
    }
  });
});
