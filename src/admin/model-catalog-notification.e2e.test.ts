import { vi } from "vitest";

const { TEST_HIVE_HOME, externalSlack, socket } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const dir = mkdtempSync(join(tmpdir(), "hive-catalog-notification-e2e-"));
  process.env.HIVE_HOME = dir;
  return {
    TEST_HIVE_HOME: dir,
    externalSlack: {
      fetch: undefined as ((input: URL | RequestInfo, init?: RequestInit) => Promise<Response>) | undefined,
    },
    socket: {
      start: vi.fn().mockResolvedValue(undefined),
      disconnect: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
    },
  };
});

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  createSdkMcpServer: vi.fn((options: { name: string }) => ({ name: options.name, type: "sdk" })),
  tool: vi.fn((name: string, description: string, inputSchema: unknown, handler: unknown) => ({
    name,
    description,
    inputSchema,
    handler,
  })),
}));

vi.mock("@slack/socket-mode", () => ({
  SocketModeClient: vi.fn().mockImplementation(function () {
    return socket;
  }),
}));

vi.mock("@slack/web-api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@slack/web-api")>();
  class ScopedWebClient extends actual.WebClient {
    constructor(token?: string, options: import("@slack/web-api").WebClientOptions = {}) {
      const fetch = externalSlack.fetch;
      if (!fetch) throw new Error("Catalog E2E WebClient constructed before its scoped fetch was installed");
      super(token, { ...options, fetch });
    }
  }
  return { ...actual, WebClient: ScopedWebClient };
});

vi.mock("../keychain/from-keychain.js", () => ({ fromKeychain: vi.fn(() => "") }));

vi.mock("../config.js", () => ({
  config: {
    instance: { id: "catalog-notification-e2e" },
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    modelRouter: { enabled: false },
    defaultAgent: "chief-of-staff",
    plugins: [],
    openai: { apiKey: "", agentModel: "" },
    codex: { agentModel: "" },
    gemini: { apiKey: "", agentModel: "" },
    kimi: { apiKey: "", agentModel: "" },
    deepseek: { apiKey: "", agentModel: "" },
    grok: { agentModel: "" },
    slack: { botToken: "", appToken: "", mcpToken: "", localMcpServer: false },
    mongo: { uri: "", dbName: "catalog-notification-e2e" },
    memory: { reflectionMinTurns: 3 },
    workflow: { enabled: false },
    google: { client: "", accounts: {}, sharedFolder: "" },
    quo: { apiKey: "", phoneNumberId: "", lines: [] },
    voice: { enabled: false, apiKey: "", phoneNumberId: "", assistants: {} },
    taskLedger: { apiUrl: "", apiKey: "", agentKeys: {} },
    brave: { apiKey: "" },
    resend: {
      apiKey: "",
      emailDomain: "",
      businessName: "",
      fromAddress: "",
      defaultCc: "",
      defaultBcc: "",
    },
    linear: { apiKey: "", teamId: "" },
    github: { repo: "", token: "" },
    clickup: { apiToken: "" },
    recall: { apiKey: "", region: "", monitorPort: 0, monitorPublicUrl: "", webhookSecret: "" },
    browser: { cdpEndpoint: "" },
    background: { port: 0, authToken: "" },
    codeTask: { port: 0, authToken: "", pluginDir: "" },
  },
}));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { rmSync } from "node:fs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AgentDefinition } from "../types/agent-definition.js";
import { JOURNALED } from "./model-catalog-export.js";
import { copy } from "./model-catalog-outbox.js";
import type { CatalogChangeDoc, CatalogDoc, CatalogVersion } from "./model-catalog-types.js";
import { CatalogError } from "./model-catalog-value.js";
import {
  createCatalogNotificationHarness,
  makeCatalogAgent,
  startCatalogNotificationMongo,
  type CatalogNotificationHarness,
  type CatalogSlackRequest,
} from "./testing/catalog-notification.test-support.js";
import { deferred, faultDb } from "./testing/catalog-db.test-support.js";

const CATALOGS = "agent_model_catalog";
const VERSIONS = "agent_model_catalog_versions";
const CHANGES = "agent_model_catalog_changes";
const AGENTS = "agent_definitions";
const AGENT_VERSIONS = "agent_definition_versions";

let harness: CatalogNotificationHarness | undefined;

function installExternalFetch(fetch: typeof externalSlack.fetch): void {
  externalSlack.fetch = fetch;
}

async function assignments(db: CatalogNotificationHarness["db"]) {
  return {
    definitions: await db.collection<AgentDefinition>(AGENTS).find().sort({ _id: 1 }).toArray(),
    versionCount: await db.collection(AGENT_VERSIONS).countDocuments(),
  };
}

async function providerState(db: CatalogNotificationHarness["db"], provider: string) {
  return {
    catalog: await db.collection<CatalogDoc>(CATALOGS).findOne({ _id: provider }),
    versions: await db.collection<CatalogVersion>(VERSIONS).find({ provider }).sort({ revision: 1 }).toArray(),
    changes: await db.collection<CatalogChangeDoc>(CHANGES).find({ provider }).sort({ revision: 1 }).toArray(),
  };
}

async function ageCompletedScan(
  db: CatalogNotificationHarness["db"],
  provider: string,
  elapsedMs = 8 * 60 * 60 * 1000,
): Promise<CatalogDoc> {
  const before = await db.collection<CatalogDoc>(CATALOGS).findOne({ _id: provider });
  if (!before?.scan?.startedAt || !before.scan.finishedAt || !before.scan.lastSucceededAt) {
    throw new Error(`Cannot age unfinished ${provider} scan fixture`);
  }
  const scan = copy(before.scan);
  scan.startedAt = new Date(scan.startedAt.getTime() - elapsedMs);
  scan.finishedAt = new Date(scan.finishedAt.getTime() - elapsedMs);
  scan.lastSucceededAt = new Date(scan.lastSucceededAt.getTime() - elapsedMs);
  const result = await db.collection<CatalogDoc>(CATALOGS).updateOne(
    {
      _id: provider,
      revision: before.revision,
      "scan.attemptId": before.scan.attemptId,
      "scan.outcome": before.scan.outcome,
    },
    { $set: { scan } },
    { ...JOURNALED, upsert: false },
  );
  expect(result.acknowledged).toBe(true);
  expect(result.matchedCount).toBe(1);
  return (await db.collection<CatalogDoc>(CATALOGS).findOne({ _id: provider }))!;
}

async function makeDeliveryDue(db: CatalogNotificationHarness["db"], id: string): Promise<CatalogChangeDoc> {
  const before = await db.collection<CatalogChangeDoc>(CHANGES).findOne({ _id: id });
  if (!before || before.delivery.state !== "pending") throw new Error(`Cannot make ${id} due from non-pending state`);
  const delivery = {
    ...copy(before.delivery),
    nextAttemptAt: new Date(Date.now() - 1_000),
    version: (before.delivery.version ?? 0) + 1,
  };
  const result = await db
    .collection<CatalogChangeDoc>(CHANGES)
    .updateOne(
      { _id: id, "delivery.state": "pending", "delivery.version": before.delivery.version },
      { $set: { delivery } },
      { ...JOURNALED, upsert: false },
    );
  expect(result.acknowledged).toBe(true);
  expect(result.matchedCount).toBe(1);
  return (await db.collection<CatalogChangeDoc>(CHANGES).findOne({ _id: id }))!;
}

function slackJson(value: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function ordinarySlack(request: CatalogSlackRequest): Response {
  if (request.kind === "auth") return slackJson({ ok: true, user_id: "UCATALOGTEST", bot_id: "BCATALOGTEST" });
  if (request.kind === "channels") {
    return slackJson({
      ok: true,
      channels: [{ id: "CNOTICE1", name: "catalog-notices" }],
      response_metadata: { next_cursor: "" },
    });
  }
  throw new Error("ordinarySlack requires an explicit post outcome");
}

beforeEach(() => {
  externalSlack.fetch = undefined;
  vi.clearAllMocks();
});

afterEach(async () => {
  await harness?.close();
  harness = undefined;
  externalSlack.fetch = undefined;
});

afterAll(() => {
  rmSync(TEST_HIVE_HOME, { recursive: true, force: true });
});

describe("catalog notification application E2E", () => {
  it("boots the three built-in scanners and delivers each historical bootstrap through Slack", async () => {
    const discoveries: string[] = [];
    harness = await createCatalogNotificationHarness({
      installExternalFetch,
      discover: async (provider) => {
        discoveries.push(provider);
        return [{ id: `${provider}-primary`, displayName: `${provider.toUpperCase()} Primary` }];
      },
    });
    const assignmentBefore = await assignments(harness.db);

    await harness.scanner.tick();
    await harness.notifier.tick();

    expect(discoveries.sort()).toEqual(["claude", "codex", "grok"]);
    expect(discoveries).not.toContain("gemini");
    expect(discoveries).not.toContain("sol");
    const changes = await harness.db.collection<CatalogChangeDoc>(CHANGES).find().sort({ provider: 1 }).toArray();
    const versions = await harness.db.collection<CatalogVersion>(VERSIONS).find().sort({ provider: 1 }).toArray();
    expect(changes).toHaveLength(3);
    expect(versions).toHaveLength(3);
    expect(harness.turns).toHaveLength(3);
    expect(harness.posts).toHaveLength(3);

    for (const provider of ["claude", "codex", "grok"] as const) {
      const state = await providerState(harness.db, provider);
      expect(state.catalog).toMatchObject({
        _id: provider,
        provider,
        models: [
          { id: `${provider}-primary`, displayName: `${provider.toUpperCase()} Primary`, addedAt: expect.any(Date) },
        ],
        revision: 1,
        source: "discovery",
        updatedBy: "system:model-catalog-scanner",
        scan: {
          outcome: "succeeded",
          startedAt: expect.any(Date),
          finishedAt: expect.any(Date),
          lastSucceededAt: expect.any(Date),
        },
      });
      expect(state.catalog?.scan?.error).toBeUndefined();
      expect(state.versions).toHaveLength(1);
      expect(state.versions[0]).toMatchObject({
        _id: state.catalog?.commitId,
        revision: 1,
        snapshot: state.catalog?.models,
        bootstrap: true,
        added: [`${provider}-primary`],
        removed: [],
        modelCount: 1,
      });
      expect(state.changes).toHaveLength(1);
      expect(state.changes[0]).toMatchObject({
        _id: state.catalog?.commitId,
        snapshotId: state.catalog?.snapshotId,
        delivery: {
          state: "delivered",
          attempts: 1,
          preparation: {
            binding: {
              agentId: "chief-of-staff",
              homeBase: "CNOTICE1",
              adapterId: "slack",
              channelId: "CNOTICE1",
            },
          },
          receipt: {
            channelId: "CNOTICE1",
            messageTs: expect.stringMatching(/^1900000000\./),
          },
        },
      });
      const turn = harness.turns.find(({ workItem }) => workItem.meta?.catalogCommitId === state.changes[0]?._id);
      expect(turn).toMatchObject({
        agentId: "chief-of-staff",
        workItem: {
          id: `catalog-change:${state.changes[0]?._id}`,
          sender: "system",
          source: { kind: "slack", id: "CNOTICE1", label: "CNOTICE1", adapterId: "slack" },
          meta: {
            systemNotification: "catalog-change",
            catalogCommitId: state.changes[0]?._id,
            targetAgentId: "chief-of-staff",
          },
        },
      });
      expect(turn?.workItem.text).toContain("Initial catalog seed");
      expect(turn?.workItem.text).toContain(`Provider: "${provider}"`);
      expect(turn?.workItem.text).toContain("Historical revision; it may no longer be the latest catalog.");
    }
    for (const post of harness.posts) {
      expect(post).toMatchObject({
        channel: "CNOTICE1",
        text: expect.stringContaining("processed this catalog notice"),
        returned: { ok: true, channel: "CNOTICE1", ts: expect.stringMatching(/^1900000000\./) },
      });
    }
    expect(await assignments(harness.db)).toEqual(assignmentBefore);
  });

  it("uses the real admin refresh handler for plugin bootstrap and membership-only notices", async () => {
    harness = await createCatalogNotificationHarness({ installExternalFetch });
    const assignmentBefore = await assignments(harness.db);
    const bootstrap = await harness.manual({
      provider: "sol",
      models: [{ id: "sol-a", displayName: "Sol A", notes: "operator note" }],
      changeSummary: "installed Sol A",
    });
    expect(bootstrap).toEqual({
      content: [
        {
          type: "text",
          text: "sol catalog updated: +1 (sol-a), -0. 1 models total. — installed Sol A",
        },
      ],
    });
    await harness.notifier.tick();

    const first = await providerState(harness.db, "sol");
    expect(first.catalog).toMatchObject({
      _id: "sol",
      models: [{ id: "sol-a", displayName: "Sol A", notes: "operator note", addedAt: expect.any(Date) }],
      revision: 1,
      source: "manual",
      updatedBy: "test-operator",
    });
    expect(first.versions).toHaveLength(1);
    expect(first.versions[0]?.changeSummary).toBe("installed Sol A");
    expect(first.changes).toHaveLength(1);
    expect(first.changes[0]?.delivery.state).toBe("delivered");

    await expect(
      harness.manual({
        provider: "sol",
        models: [{ id: "sol-a", displayName: "Renamed Sol A", notes: "revised note" }],
        changeSummary: "name and note only",
      }),
    ).resolves.toMatchObject({ content: [{ text: expect.stringContaining("+0, -0") }] });
    await expect(
      harness.manual({
        provider: "sol",
        models: [{ id: "sol-a", displayName: "Renamed Sol A", notes: "revised note" }],
        changeSummary: "identical audit",
      }),
    ).resolves.toMatchObject({ content: [{ text: expect.stringContaining("+0, -0") }] });
    await expect(
      harness.manual({
        provider: "sol",
        models: [
          { id: "sol-a", displayName: "Renamed Sol A", notes: "revised note" },
          { id: "sol-b", displayName: "Sol B" },
        ],
        changeSummary: "add Sol B",
      }),
    ).resolves.toMatchObject({ content: [{ text: expect.stringContaining("+1 (sol-b), -0") }] });
    await expect(
      harness.manual({
        provider: "sol",
        models: [
          { id: "sol-b", displayName: "Sol B" },
          { id: "sol-a", displayName: "Renamed Sol A", notes: "revised note" },
        ],
        changeSummary: "order only",
      }),
    ).resolves.toMatchObject({ content: [{ text: expect.stringContaining("+0, -0") }] });
    await harness.notifier.tick();

    const final = await providerState(harness.db, "sol");
    expect(final.catalog).toMatchObject({
      revision: 5,
      models: [
        { id: "sol-b", displayName: "Sol B", addedAt: expect.any(Date) },
        {
          id: "sol-a",
          displayName: "Renamed Sol A",
          notes: "revised note",
          addedAt: first.catalog?.models?.[0]?.addedAt,
        },
      ],
    });
    expect(final.versions.map((version) => version.changeSummary)).toEqual([
      "installed Sol A",
      "name and note only",
      "identical audit",
      "add Sol B",
      "order only",
    ]);
    expect(final.changes).toHaveLength(2);
    expect(final.changes.map((change) => change.revision)).toEqual([1, 4]);
    expect(final.changes.every((change) => change.delivery.state === "delivered")).toBe(true);
    expect(harness.turns).toHaveLength(2);
    expect(harness.posts).toHaveLength(2);
    expect(await assignments(harness.db)).toEqual(assignmentBefore);
  });

  it("runs current-clock eight-hour unchanged and failed checks without creating notices", async () => {
    const calls = new Map<string, number>();
    harness = await createCatalogNotificationHarness({
      installExternalFetch,
      discover: async (provider) => {
        const count = (calls.get(provider) ?? 0) + 1;
        calls.set(provider, count);
        if (provider === "codex" && count === 2) {
          throw new CatalogError({ code: "auth", message: "private provider detail" });
        }
        return [{ id: `${provider}-stable`, displayName: `${provider.toUpperCase()} Stable` }];
      },
    });
    const assignmentBefore = await assignments(harness.db);
    await harness.scanner.tick();
    const originallySeeded = new Map<string, CatalogDoc>();
    for (const provider of ["claude", "codex", "grok"]) {
      const aged = await ageCompletedScan(harness.db, provider);
      originallySeeded.set(provider, copy(aged));
    }

    await harness.scanner.tick();

    expect(Object.fromEntries(calls)).toEqual({ claude: 2, grok: 2, codex: 2 });
    expect(await harness.db.collection(VERSIONS).countDocuments()).toBe(3);
    expect(await harness.db.collection(CHANGES).countDocuments()).toBe(3);
    expect(harness.turns).toEqual([]);
    expect(harness.posts).toEqual([]);
    for (const provider of ["claude", "grok"]) {
      const before = originallySeeded.get(provider)!;
      const after = (await providerState(harness.db, provider)).catalog!;
      expect(after.models).toEqual(before.models);
      expect(after.revision).toBe(1);
      expect(after.commitId).toBe(before.commitId);
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.scan).toMatchObject({
        outcome: "succeeded",
        finishedAt: expect.any(Date),
        lastSucceededAt: expect.any(Date),
      });
      expect(after.scan?.attemptId).not.toBe(before.scan?.attemptId);
      expect(after.scan?.lastSucceededAt?.getTime()).toBeGreaterThan(before.scan!.lastSucceededAt!.getTime());
      expect(after.scan?.error).toBeUndefined();
    }
    const codexBefore = originallySeeded.get("codex")!;
    const codexAfter = (await providerState(harness.db, "codex")).catalog!;
    expect(codexAfter.models).toEqual(codexBefore.models);
    expect(codexAfter.revision).toBe(1);
    expect(codexAfter.commitId).toBe(codexBefore.commitId);
    expect(codexAfter.updatedAt).toEqual(codexBefore.updatedAt);
    expect(codexAfter.scan).toMatchObject({
      outcome: "failed",
      startedAt: expect.any(Date),
      finishedAt: expect.any(Date),
      lastSucceededAt: codexBefore.scan?.lastSucceededAt,
      error: { code: "auth", message: "Model catalog codex: auth." },
    });
    expect(codexAfter.scan?.attemptId).not.toBe(codexBefore.scan?.attemptId);
    const pending = await harness.db.collection<CatalogChangeDoc>(CHANGES).find().toArray();
    expect(pending).toHaveLength(3);
    expect(pending.every((change) => change.delivery.state === "pending" && change.delivery.attempts === 0)).toBe(true);
    expect(await assignments(harness.db)).toEqual(assignmentBefore);
  });

  it("rebases a held discovery over a real manual replacement and delivers every historical membership event", async () => {
    const held = deferred<{ id: string; displayName: string }[]>();
    const entered = deferred<void>();
    let codexCalls = 0;
    harness = await createCatalogNotificationHarness({
      installExternalFetch,
      discover: async (provider) => {
        if (provider !== "codex") return [{ id: `${provider}-only`, displayName: `${provider} only` }];
        codexCalls += 1;
        if (codexCalls === 1) {
          return [
            { id: "model-a", displayName: "Discovery A" },
            { id: "model-b", displayName: "Discovery B" },
          ];
        }
        entered.resolve();
        return held.promise;
      },
    });
    const assignmentBefore = await assignments(harness.db);
    await harness.scanner.tick();
    const initial = await providerState(harness.db, "codex");
    const initialAddedAt = initial.catalog!.models!.find((model) => model.id === "model-a")!.addedAt;
    await ageCompletedScan(harness.db, "codex", 8 * 60 * 60 * 1000 + 1_000);

    const scanFlight = harness.scanner.tick();
    await entered.promise;
    try {
      const manual = await harness.manual({
        provider: "codex",
        models: [
          { id: "model-a", displayName: "Manual A", notes: "retain this note" },
          { id: "model-c", displayName: "Manual C" },
        ],
        changeSummary: "operator replaced B with C",
      });
      expect(manual).toEqual({
        content: [
          {
            type: "text",
            text: "codex catalog updated: +1 (model-c), -1 (model-b). 2 models total. — operator replaced B with C",
          },
        ],
      });
      const during = await providerState(harness.db, "codex");
      expect(during.catalog).toMatchObject({
        revision: 2,
        source: "manual",
        models: [
          { id: "model-a", displayName: "Manual A", notes: "retain this note", addedAt: initialAddedAt },
          { id: "model-c", displayName: "Manual C", addedAt: expect.any(Date) },
        ],
        scan: { outcome: "running" },
      });
      expect(during.versions).toHaveLength(2);
      expect(during.changes).toHaveLength(2);
      expect(during.changes[1]).toMatchObject({ revision: 2, added: ["model-c"], removed: ["model-b"] });

      held.resolve([
        { id: "model-b", displayName: "Discovery B2" },
        { id: "model-a", displayName: "Discovery A2" },
      ]);
      await scanFlight;
    } finally {
      held.resolve([]);
      await scanFlight;
    }

    const final = await providerState(harness.db, "codex");
    expect(codexCalls).toBe(2);
    expect(final.catalog).toMatchObject({
      revision: 3,
      source: "discovery",
      updatedBy: "system:model-catalog-scanner",
      models: [
        { id: "model-b", displayName: "Discovery B2", addedAt: expect.any(Date) },
        { id: "model-a", displayName: "Discovery A2", notes: "retain this note", addedAt: initialAddedAt },
      ],
      scan: { outcome: "succeeded", lastSucceededAt: expect.any(Date) },
    });
    expect(final.versions).toHaveLength(3);
    expect(final.versions.map(({ revision, added, removed }) => ({ revision, added, removed }))).toEqual([
      { revision: 1, added: ["model-a", "model-b"], removed: [] },
      { revision: 2, added: ["model-c"], removed: ["model-b"] },
      { revision: 3, added: ["model-b"], removed: ["model-c"] },
    ]);
    expect(final.changes).toHaveLength(3);
    expect(final.changes.map((change) => change._id)).toEqual(final.versions.map((version) => version._id));

    await harness.notifier.tick();
    const delivered = await providerState(harness.db, "codex");
    expect(delivered.changes.every((change) => change.delivery.state === "delivered")).toBe(true);
    const codexIds = new Set(delivered.changes.map((change) => change._id));
    const historicalTurns = harness.turns.filter(({ workItem }) =>
      codexIds.has(String(workItem.meta?.catalogCommitId)),
    );
    expect(historicalTurns).toHaveLength(3);
    expect(historicalTurns[1]?.workItem.text).toContain('Added IDs: "model-c"');
    expect(historicalTurns[1]?.workItem.text).toContain('Removed IDs: "model-b"');
    expect(historicalTurns[2]?.workItem.text).toContain('Added IDs: "model-b"');
    expect(historicalTurns[2]?.workItem.text).toContain('Removed IDs: "model-c"');
    expect(await assignments(harness.db)).toEqual(assignmentBefore);
  });

  it("keeps scanner and manual events pending across invalid recipients and routes every event after repair", async () => {
    harness = await createCatalogNotificationHarness({ installExternalFetch });
    const definitions = harness.db.collection<AgentDefinition>(AGENTS);
    await definitions.deleteMany({});
    await definitions.insertOne(
      makeCatalogAgent({
        _id: "non-default-observer",
        name: "Non-default Observer",
        isDefault: false,
      }),
    );
    await harness.registry.load();

    await harness.scanner.tick();
    await harness.notifier.tick();
    expect(await harness.db.collection(VERSIONS).countDocuments()).toBe(3);
    expect(await harness.db.collection(CHANGES).countDocuments()).toBe(3);

    await definitions.deleteMany({});
    await definitions.insertOne(makeCatalogAgent({ disabled: true }));
    await harness.registry.load();
    await harness.manual({ provider: "sol", models: [{ id: "sol-a", displayName: "Sol A" }] });
    await harness.notifier.tick();

    await definitions.updateOne(
      { _id: "chief-of-staff" },
      { $set: { disabled: false, isDefault: true, homeBase: "CNOTICE1", updatedAt: new Date() } },
    );
    await definitions.insertOne(
      makeCatalogAgent({ _id: "second-default", name: "Second Default", isDefault: true, homeBase: "CNOTICE2" }),
    );
    await harness.registry.load();
    await harness.manual({
      provider: "sol",
      models: [
        { id: "sol-a", displayName: "Sol A" },
        { id: "sol-b", displayName: "Sol B" },
      ],
    });
    await harness.notifier.tick();

    await definitions.updateOne({ _id: "second-default" }, { $set: { isDefault: false, updatedAt: new Date() } });
    await definitions.updateOne({ _id: "chief-of-staff" }, { $set: { homeBase: " ", updatedAt: new Date() } });
    await harness.registry.load();
    await harness.manual({
      provider: "sol",
      models: [
        { id: "sol-a", displayName: "Sol A" },
        { id: "sol-b", displayName: "Sol B" },
        { id: "sol-c", displayName: "Sol C" },
      ],
    });
    await harness.notifier.tick();

    const unresolved = await harness.db.collection<CatalogChangeDoc>(CHANGES).find().toArray();
    expect(unresolved).toHaveLength(6);
    expect(unresolved.every((change) => change.delivery.state === "pending" && change.delivery.attempts === 1)).toBe(
      true,
    );
    expect(unresolved.map((change) => change.delivery.diagnostic?.reason).sort()).toEqual([
      "destination-unresolved",
      "multiple-defaults",
      "recipient-missing",
      "recipient-missing",
      "recipient-missing",
      "recipient-missing",
    ]);
    expect(harness.turns).toEqual([]);
    expect(harness.posts).toEqual([]);
    expect((await providerState(harness.db, "sol")).versions).toHaveLength(3);
    for (const provider of ["claude", "codex", "grok"]) {
      const state = await providerState(harness.db, provider);
      expect(state.catalog).toMatchObject({ revision: 1, scan: { outcome: "succeeded" } });
      expect(state.versions).toHaveLength(1);
      expect(state.changes).toHaveLength(1);
    }

    await definitions.updateOne(
      { _id: "chief-of-staff" },
      { $set: { homeBase: "catalog-notices", updatedAt: new Date() } },
    );
    await harness.registry.load();
    const assignmentAtRepair = await assignments(harness.db);
    for (const change of unresolved) await makeDeliveryDue(harness.db, change._id);

    await harness.notifier.tick();

    const delivered = await harness.db.collection<CatalogChangeDoc>(CHANGES).find().toArray();
    expect(delivered).toHaveLength(6);
    expect(delivered.every((change) => change.delivery.state === "delivered" && change.delivery.attempts === 2)).toBe(
      true,
    );
    for (const change of delivered) {
      expect(change.delivery).toMatchObject({
        preparation: {
          binding: {
            agentId: "chief-of-staff",
            homeBase: "catalog-notices",
            channelId: "CNOTICE1",
            adapterId: "slack",
          },
        },
        receipt: { channelId: "CNOTICE1", messageTs: expect.stringMatching(/^1900000000\./) },
      });
    }
    expect(harness.turns).toHaveLength(6);
    expect(harness.posts).toHaveLength(6);
    expect(harness.posts.every((post) => post.channel === "CNOTICE1")).toBe(true);
    expect(await assignments(harness.db)).toEqual(assignmentAtRepair);
  });

  it("reuses one persisted preparation after a definite refusal and fresh-process restart", async () => {
    const mongo = await startCatalogNotificationMongo();
    let first: CatalogNotificationHarness | undefined;
    let restarted: CatalogNotificationHarness | undefined;
    try {
      first = await createCatalogNotificationHarness({
        db: mongo.db,
        installExternalFetch,
        slack: async (request) =>
          request.kind === "post" ? slackJson({ ok: false, error: "channel_not_found" }) : ordinarySlack(request),
      });
      harness = first;
      const assignmentBefore = await assignments(first.db);
      await first.manual({ provider: "sol", models: [{ id: "sol-refusal", displayName: "Sol Refusal" }] });
      await first.notifier.tick();
      const pending = (await providerState(first.db, "sol")).changes[0]!;
      const preparation = copy(pending.delivery.preparation!);
      expect(pending.delivery).toMatchObject({
        state: "pending",
        attempts: 1,
        preparation,
        uncertainSend: false,
        diagnostic: { reason: "delivery-unconfirmed" },
      });
      expect(pending.delivery.claim).toBeUndefined();
      expect(pending.delivery.receipt).toBeUndefined();
      expect(first.turns).toHaveLength(1);
      expect(first.posts).toEqual([
        { channel: "CNOTICE1", text: preparation.text, returned: { ok: false, error: "channel_not_found" } },
      ]);

      await first.close();
      harness = undefined;
      await makeDeliveryDue(mongo.db, pending._id);
      restarted = await createCatalogNotificationHarness({
        db: mongo.db,
        seedAgent: false,
        installExternalFetch,
        turn: async () => {
          throw new Error("Persisted preparation unexpectedly regenerated after restart");
        },
      });
      harness = restarted;
      await restarted.notifier.tick();
      await restarted.notifier.tick();

      const final = (await providerState(restarted.db, "sol")).changes[0]!;
      expect(final.delivery).toMatchObject({
        state: "delivered",
        attempts: 2,
        preparation,
        uncertainSend: false,
        receipt: {
          preparationId: preparation.id,
          binding: preparation.binding,
          channelId: "CNOTICE1",
          messageTs: expect.stringMatching(/^1900000000\./),
        },
      });
      expect(restarted.turns).toEqual([]);
      expect(restarted.posts).toEqual([
        {
          channel: "CNOTICE1",
          text: preparation.text,
          returned: { ok: true, channel: "CNOTICE1", ts: expect.stringMatching(/^1900000000\./) },
        },
      ]);
      expect(await assignments(restarted.db)).toEqual(assignmentBefore);
    } finally {
      await first?.close();
      await restarted?.close();
      harness = undefined;
      await mongo.close();
    }
  });

  it("waits for a delayed unknown catalog commit and lets scanner recovery export its exact event", async () => {
    const mongo = await startCatalogNotificationMongo();
    const delayedEntered = deferred<void>();
    let holdChangedCommit = false;
    let delayedCommit: (() => Promise<{ acknowledged: boolean; matchedCount: number }>) | undefined;
    const intercepted = faultDb(mongo.db, async (collection, method, args, run) => {
      if (
        holdChangedCommit &&
        !delayedCommit &&
        collection === CATALOGS &&
        method === "updateOne" &&
        args[0]?._id === "codex" &&
        args[1]?.$set?.pendingExport
      ) {
        delayedCommit = run;
        delayedEntered.resolve();
        throw new Error("catalog test lost acknowledgment before server delegation");
      }
      return run();
    });
    const calls = new Map<string, number>();
    try {
      harness = await createCatalogNotificationHarness({
        db: intercepted,
        installExternalFetch,
        discover: async (provider) => {
          const count = (calls.get(provider) ?? 0) + 1;
          calls.set(provider, count);
          if (provider !== "codex" || count === 1) {
            return [{ id: `${provider}-a`, displayName: `${provider.toUpperCase()} A` }];
          }
          return [
            { id: "codex-a", displayName: "CODEX A renamed" },
            { id: "codex-b", displayName: "CODEX B" },
          ];
        },
      });
      const assignmentBefore = await assignments(harness.db);
      await harness.scanner.tick();
      await harness.notifier.tick();
      const initial = await providerState(harness.db, "codex");
      const retainedAddedAt = initial.catalog!.models![0]!.addedAt;
      const initialPosts = harness.posts.length;
      await ageCompletedScan(harness.db, "codex", 8 * 60 * 60 * 1000 + 1_000);

      holdChangedCommit = true;
      await harness.scanner.tick();
      await delayedEntered.promise;

      const negativeEvidence = await providerState(harness.db, "codex");
      expect(negativeEvidence.catalog).toMatchObject({
        revision: 1,
        models: [{ id: "codex-a", displayName: "CODEX A", addedAt: retainedAddedAt }],
        scan: { outcome: "running" },
      });
      expect(negativeEvidence.catalog).not.toHaveProperty("pendingExport");
      expect(negativeEvidence.versions).toHaveLength(1);
      expect(negativeEvidence.changes).toHaveLength(1);
      await harness.notifier.tick();
      expect(harness.posts).toHaveLength(initialPosts);
      expect(calls.get("codex")).toBe(2);

      const delegated = await delayedCommit!();
      expect(delegated.acknowledged).toBe(true);
      expect(delegated.matchedCount).toBe(1);
      const awaitingExport = await providerState(harness.db, "codex");
      expect(awaitingExport.catalog).toMatchObject({
        revision: 2,
        pendingExport: {
          version: {
            revision: 2,
            added: ["codex-b"],
            removed: [],
            snapshot: [
              { id: "codex-a", displayName: "CODEX A renamed", addedAt: retainedAddedAt },
              { id: "codex-b", displayName: "CODEX B", addedAt: expect.any(Date) },
            ],
          },
        },
      });
      expect(awaitingExport.versions).toHaveLength(1);
      expect(awaitingExport.changes).toHaveLength(1);

      await harness.scanner.tick();
      expect(calls.get("codex")).toBe(2);
      const recovered = await providerState(harness.db, "codex");
      expect(recovered.catalog).not.toHaveProperty("pendingExport");
      expect(recovered.versions).toHaveLength(2);
      expect(recovered.changes).toHaveLength(2);
      expect(recovered.versions[1]).toMatchObject({
        _id: recovered.catalog?.commitId,
        revision: 2,
        snapshot: recovered.catalog?.models,
        added: ["codex-b"],
        removed: [],
      });
      expect(recovered.changes[1]).toMatchObject({
        _id: recovered.versions[1]?._id,
        delivery: { state: "pending", attempts: 0 },
      });

      await harness.notifier.tick();
      const delivered = await providerState(harness.db, "codex");
      expect(delivered.changes[1]?.delivery).toMatchObject({
        state: "delivered",
        attempts: 1,
        preparation: { binding: { agentId: "chief-of-staff", channelId: "CNOTICE1" } },
        receipt: { channelId: "CNOTICE1", messageTs: expect.stringMatching(/^1900000000\./) },
      });
      expect(harness.posts).toHaveLength(initialPosts + 1);
      expect(harness.posts.at(-1)?.text).toContain('Added IDs: "codex-b"');
      expect(await assignments(harness.db)).toEqual(assignmentBefore);
    } finally {
      await harness?.close();
      harness = undefined;
      await mongo.close();
    }
  });

  it("settles a known Slack receipt from evidence and exposes fresh-process crash duplication", async () => {
    const mongo = await startCatalogNotificationMongo();
    const ackNegative = deferred<void>();
    let ackThrown = false;
    let returnedNegativeEvidence = false;
    let delayedAck: (() => Promise<{ acknowledged: boolean; matchedCount: number }>) | undefined;
    const ackFaultDb = faultDb(mongo.db, async (collection, method, args, run) => {
      if (
        !ackThrown &&
        collection === CHANGES &&
        method === "updateOne" &&
        args[1]?.$set?.delivery?.state === "delivered"
      ) {
        ackThrown = true;
        delayedAck = run;
        throw new Error("catalog test lost durable receipt acknowledgment before delegation");
      }
      if (ackThrown && !returnedNegativeEvidence && collection === CHANGES && method === "findOne") {
        const result = await run();
        returnedNegativeEvidence = true;
        ackNegative.resolve();
        return result;
      }
      return run();
    });
    let localReceipt: CatalogNotificationHarness | undefined;
    let crashWorker: CatalogNotificationHarness | undefined;
    let recoveredWorker: CatalogNotificationHarness | undefined;
    const crashPostEntered = deferred<void>();
    const crashPostRelease = deferred<Response>();
    let crashFlight: Promise<void> | undefined;
    try {
      localReceipt = await createCatalogNotificationHarness({
        db: ackFaultDb,
        installExternalFetch,
        notifier: { pollMs: 25, leaseMs: 2_000, renewMs: 500, drainMs: 25 },
      });
      harness = localReceipt;
      const assignmentBefore = await assignments(localReceipt.db);
      await localReceipt.manual({ provider: "sol", models: [{ id: "sol-a", displayName: "Sol A" }] });
      const receiptFlight = localReceipt.notifier.tick();
      await ackNegative.promise;
      const whileUnknown = (await providerState(localReceipt.db, "sol")).changes[0]!;
      expect(whileUnknown.delivery).toMatchObject({
        state: "claimed",
        attempts: 1,
        claim: { stage: "sending", sendIntent: { previouslyUncertain: false } },
        preparation: { binding: { channelId: "CNOTICE1" } },
      });
      expect(localReceipt.posts).toHaveLength(1);
      const delayedResult = await delayedAck!();
      expect(delayedResult.acknowledged).toBe(true);
      expect(delayedResult.matchedCount).toBe(1);
      await receiptFlight;
      const settled = (await providerState(localReceipt.db, "sol")).changes[0]!;
      expect(settled.delivery).toMatchObject({
        state: "delivered",
        attempts: 1,
        uncertainSend: false,
        receipt: {
          preparationId: settled.delivery.preparation?.id,
          channelId: "CNOTICE1",
          messageTs: expect.stringMatching(/^1900000000\./),
        },
      });
      expect(localReceipt.turns).toHaveLength(1);
      expect(localReceipt.posts).toHaveLength(1);
      await localReceipt.close();
      localReceipt = undefined;
      harness = undefined;

      crashWorker = await createCatalogNotificationHarness({
        db: mongo.db,
        seedAgent: false,
        installExternalFetch,
        slack: async (request) => {
          if (request.kind !== "post") return ordinarySlack(request);
          crashPostEntered.resolve();
          return crashPostRelease.promise;
        },
        notifier: { pollMs: 25, leaseMs: 2_000, renewMs: 500, drainMs: 25 },
      });
      harness = crashWorker;
      await crashWorker.manual({
        provider: "sol",
        models: [
          { id: "sol-a", displayName: "Sol A" },
          { id: "sol-b", displayName: "Sol B" },
        ],
      });
      crashFlight = crashWorker.notifier.tick();
      await crashPostEntered.promise;
      const beforeCrash = (await providerState(crashWorker.db, "sol")).changes[1]!;
      const crashPreparation = copy(beforeCrash.delivery.preparation!);
      expect(beforeCrash.delivery).toMatchObject({
        state: "claimed",
        attempts: 1,
        uncertainSend: false,
        preparation: crashPreparation,
        claim: { stage: "sending", sendIntent: { preparationId: crashPreparation.id, previouslyUncertain: false } },
      });
      const crashPosts = crashWorker.posts;
      const crashTurns = crashWorker.turns;
      await crashWorker.close();
      crashWorker = undefined;
      harness = undefined;
      crashPostRelease.resolve(slackJson({ ok: true, channel: "CNOTICE1", ts: "1910000000.000001" }));
      await crashFlight;

      const abandoned = await mongo.db.collection<CatalogChangeDoc>(CHANGES).findOne({ _id: beforeCrash._id });
      expect(abandoned?.delivery).toMatchObject({
        state: "claimed",
        preparation: crashPreparation,
        claim: { stage: "sending", sendIntent: { preparationId: crashPreparation.id } },
      });
      const expiredAt = new Date(Date.now() - 1);
      expect(expiredAt.getTime()).toBeGreaterThan(abandoned!.delivery.claim!.startedAt.getTime());
      const expiry = await mongo.db.collection<CatalogChangeDoc>(CHANGES).updateOne(
        {
          _id: beforeCrash._id,
          "delivery.state": "claimed",
          "delivery.version": abandoned!.delivery.version,
        },
        {
          $set: {
            "delivery.claim.leaseExpiresAt": expiredAt,
            "delivery.version": (abandoned!.delivery.version ?? 0) + 1,
          },
        },
        { ...JOURNALED, upsert: false },
      );
      expect(expiry.acknowledged).toBe(true);
      expect(expiry.matchedCount).toBe(1);

      recoveredWorker = await createCatalogNotificationHarness({
        db: mongo.db,
        seedAgent: false,
        installExternalFetch,
        turn: async () => {
          throw new Error("Crash recovery unexpectedly regenerated a persisted preparation");
        },
      });
      harness = recoveredWorker;
      await recoveredWorker.notifier.tick();
      const recovered = (await providerState(recoveredWorker.db, "sol")).changes[1]!;
      expect(recovered.delivery).toMatchObject({
        state: "delivered",
        attempts: 2,
        uncertainSend: true,
        preparation: crashPreparation,
        receipt: {
          preparationId: crashPreparation.id,
          channelId: "CNOTICE1",
          messageTs: expect.stringMatching(/^1900000000\./),
        },
      });
      expect(crashTurns).toHaveLength(1);
      expect(recoveredWorker.turns).toEqual([]);
      expect([...crashPosts, ...recoveredWorker.posts].map((post) => post.text)).toEqual([
        crashPreparation.text,
        crashPreparation.text,
      ]);
      expect([...crashPosts, ...recoveredWorker.posts].map((post) => post.channel)).toEqual(["CNOTICE1", "CNOTICE1"]);
      const sol = await providerState(recoveredWorker.db, "sol");
      expect(sol.versions).toHaveLength(2);
      expect(sol.changes).toHaveLength(2);
      expect(sol.changes.every((change) => change.delivery.state === "delivered")).toBe(true);
      expect(await assignments(recoveredWorker.db)).toEqual(assignmentBefore);
    } finally {
      await localReceipt?.close();
      await crashWorker?.close();
      crashPostRelease.resolve(slackJson({ ok: false, error: "catalog_test_cleanup" }));
      await crashFlight?.catch(() => undefined);
      await recoveredWorker?.close();
      harness = undefined;
      await mongo.close();
    }
  });

  it("rebinds an uncertain event to the current default and preserves possible cross-recipient duplication", async () => {
    let postCount = 0;
    harness = await createCatalogNotificationHarness({
      installExternalFetch,
      slack: async (request) => {
        if (request.kind !== "post") return ordinarySlack(request);
        postCount += 1;
        if (postCount === 1) throw new Error("catalog test transport outcome unknown");
        return slackJson({ ok: true, channel: request.body.get("channel"), ts: "1920000000.000001" });
      },
    });
    await harness.manual({ provider: "sol", models: [{ id: "sol-rebind", displayName: "Sol Rebind" }] });
    await harness.notifier.tick();
    const original = (await providerState(harness.db, "sol")).changes[0]!;
    const firstPreparation = copy(original.delivery.preparation!);
    expect(original.delivery).toMatchObject({
      state: "pending",
      attempts: 1,
      uncertainSend: true,
      preparation: { binding: { agentId: "chief-of-staff", homeBase: "CNOTICE1", channelId: "CNOTICE1" } },
      diagnostic: { reason: "delivery-unconfirmed" },
    });
    expect(harness.posts).toHaveLength(1);
    expect(harness.posts[0]).toMatchObject({ channel: "CNOTICE1", text: firstPreparation.text });

    const definitions = harness.db.collection<AgentDefinition>(AGENTS);
    await definitions.updateOne({ _id: "chief-of-staff" }, { $set: { isDefault: false, updatedAt: new Date() } });
    await definitions.insertOne(
      makeCatalogAgent({
        _id: "current-chief",
        name: "Current Chief",
        isDefault: true,
        homeBase: "CNOTICE2",
        channels: ["CNOTICE2"],
      }),
    );
    await harness.registry.load();
    const assignmentAtRepair = await assignments(harness.db);
    await makeDeliveryDue(harness.db, original._id);

    await harness.notifier.tick();

    const finalState = await providerState(harness.db, "sol");
    expect(finalState.versions).toHaveLength(1);
    expect(finalState.changes).toHaveLength(1);
    const final = finalState.changes[0]!;
    expect(final._id).toBe(original._id);
    expect(final.delivery).toMatchObject({
      state: "delivered",
      attempts: 2,
      uncertainSend: true,
      preparation: {
        binding: { agentId: "current-chief", homeBase: "CNOTICE2", channelId: "CNOTICE2", adapterId: "slack" },
      },
      receipt: {
        preparationId: final.delivery.preparation?.id,
        binding: final.delivery.preparation?.binding,
        channelId: "CNOTICE2",
        messageTs: "1920000000.000001",
      },
    });
    expect(final.delivery.preparation?.id).not.toBe(firstPreparation.id);
    expect(harness.turns.map((turn) => turn.agentId)).toEqual(["chief-of-staff", "current-chief"]);
    expect(harness.turns.map((turn) => turn.workItem.meta?.catalogCommitId)).toEqual([original._id, original._id]);
    expect(harness.posts.map((post) => post.channel)).toEqual(["CNOTICE1", "CNOTICE2"]);
    expect(harness.posts[0]?.returned).toEqual({ threw: "catalog test transport outcome unknown" });
    expect(harness.posts[1]?.returned).toEqual({ ok: true, channel: "CNOTICE2", ts: "1920000000.000001" });
    expect(await assignments(harness.db)).toEqual(assignmentAtRepair);
  });
});
