import { vi } from "vitest";

const {
  TEST_HIVE_HOME,
  externalSlack,
  socket,
  runnerConstructed,
  runnerSend,
  runnerAbort,
  runnerToolInventory,
  runnerInProcessServers,
  runnerResolveTurnCwd,
  runnerBuildProviderPrompt,
  conversationIndexRecord,
} = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdirSync, mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const dir = mkdtempSync(join(tmpdir(), "hive-catalog-agent-manager-e2e-"));
  const scratch = join(dir, "agent-scratch");
  mkdirSync(scratch, { recursive: true });
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
    runnerConstructed: vi.fn(),
    runnerSend: vi.fn(async () => ({
      text: "I will bring any proposal to the operator.",
      sessionId: "catalog-test-session",
      costUsd: 0.01,
      durationMs: 20,
      llmMs: 15,
      toolMs: 0,
      toolCalls: 0,
      toolSummary: null,
      streamed: false,
      aborted: false,
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 200_000,
      compactions: 0,
    })),
    runnerAbort: vi.fn(),
    runnerToolInventory: vi.fn(() => []),
    runnerInProcessServers: vi.fn(() => ({})),
    runnerResolveTurnCwd: vi.fn(() => scratch),
    runnerBuildProviderPrompt: vi.fn(async () => ({
      instructions: "Catalog notification E2E provider instructions.",
      skillEntries: [],
    })),
    conversationIndexRecord: vi.fn().mockResolvedValue(undefined),
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
      if (!fetch) throw new Error("Catalog AgentManager E2E WebClient constructed before fetch installation");
      super(token, { ...options, fetch });
    }
  }
  return { ...actual, WebClient: ScopedWebClient };
});

vi.mock("../keychain/from-keychain.js", () => ({ fromKeychain: vi.fn(() => "") }));

vi.mock("../config.js", () => ({
  config: {
    instance: { id: "catalog-agent-manager-e2e" },
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
    mongo: { uri: "", dbName: "catalog-agent-manager-e2e" },
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

vi.mock("../plugins/plugin-loader.js", () => ({
  loadPlugins: vi.fn(() => []),
  rescanPluginBrokenServers: vi.fn(() => ({ rescued: {}, stillBroken: {} })),
}));

vi.mock("../search/conversation-index.js", () => ({
  ConversationIndex: vi.fn().mockImplementation(function () {
    return { index: conversationIndexRecord };
  }),
}));

vi.mock("../agents/agent-runner.js", () => ({
  AgentRunner: vi.fn().mockImplementation(function (...args: unknown[]) {
    runnerConstructed(...args);
    return {
      send: runnerSend,
      abort: runnerAbort,
      wasAborted: false,
      buildToolTransportInventory: runnerToolInventory,
      buildInProcessServers: runnerInProcessServers,
      resolveTurnCwd: runnerResolveTurnCwd,
      buildProviderPrompt: runnerBuildProviderPrompt,
    };
  }),
  DIST_DIR: TEST_HIVE_HOME,
}));

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import { rmSync } from "node:fs";
import type { Db } from "mongodb";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { AgentManager, type TurnContext } from "../agents/agent-manager.js";
import { ClaudeAgentAdapter } from "../agents/provider-adapters/claude-agent-adapter.js";
import { SessionStore } from "../agents/session-store.js";
import { TurnTelemetryStore, type TurnTelemetryDoc } from "../agents/turn-telemetry.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AgentDefinition, AgentDefinitionVersion } from "../types/agent-definition.js";
import type { WorkItem } from "../types/work-item.js";
import type { CatalogChangeDoc } from "./model-catalog-types.js";
import { CatalogError, safeError } from "./model-catalog-value.js";
import {
  createCatalogNotificationHarness,
  type CatalogNotificationHarness,
} from "./testing/catalog-notification.test-support.js";

const CHANGES = "agent_model_catalog_changes";
const DEFINITIONS = "agent_definitions";
const DEFINITION_VERSIONS = "agent_definition_versions";
const SESSIONS = "sessions";
const TELEMETRY = "agent_turn_telemetry";

type RestorableSpy = { mockRestore(): void };
type SessionDocument = {
  _id: string;
  agentId: string;
  threadId: string;
  sessionId: string;
  provider?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  contextWindow: number;
  compactions: number;
  createdAt: Date;
  updatedAt: Date;
};

function observeWrites<A extends unknown[], R>(original: (...args: A) => Promise<R>) {
  const pending: Promise<R>[] = [];
  return {
    call: (...args: A): Promise<R> => {
      const work = original(...args);
      pending.push(work);
      void work.catch(() => undefined);
      return work;
    },
    drain: async (): Promise<void> => {
      let observed = 0;
      while (observed < pending.length) {
        const batch = pending.slice(observed);
        observed = pending.length;
        const results = await Promise.allSettled(batch);
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed) throw failed.reason;
      }
    },
  };
}

function installExternalFetch(fetch: typeof externalSlack.fetch): void {
  externalSlack.fetch = fetch;
}

async function assignmentState(db: Db) {
  return {
    definitions: await db.collection<AgentDefinition>(DEFINITIONS).find().sort({ _id: 1 }).toArray(),
    versions: await db.collection<AgentDefinitionVersion>(DEFINITION_VERSIONS).find().sort({ agentId: 1 }).toArray(),
  };
}

let harness: CatalogNotificationHarness | undefined;
let manager: AgentManager | undefined;
let sessionStore: SessionStore | undefined;
let telemetryStore: TurnTelemetryStore | undefined;
let drainPersistence: (() => Promise<void>) | undefined;
let activeSpies: RestorableSpy[] = [];

beforeEach(() => {
  externalSlack.fetch = undefined;
  vi.clearAllMocks();
});

afterEach(async () => {
  manager?.stopAll();
  manager?.stopReflections();

  const failures: unknown[] = [];
  if (harness) {
    const scannerStop = harness.scanner.stop();
    const notifierStop = harness.notifier.stop();
    const results = await Promise.allSettled([scannerStop, notifierStop]);
    failures.push(
      ...results.filter((result): result is PromiseRejectedResult => result.status === "rejected").map((r) => r.reason),
    );
  }
  if (drainPersistence) {
    try {
      await drainPersistence();
    } catch (error) {
      failures.push(error);
    }
  }
  if (sessionStore) {
    try {
      await sessionStore.close();
    } catch (error) {
      failures.push(error);
    }
  }
  if (harness) {
    try {
      await harness.close();
    } catch (error) {
      failures.push(error);
    }
  }
  for (const spy of activeSpies.reverse()) spy.mockRestore();

  harness = undefined;
  manager = undefined;
  sessionStore = undefined;
  telemetryStore = undefined;
  drainPersistence = undefined;
  activeSpies = [];
  externalSlack.fetch = undefined;
  if (failures.length) throw failures[0];
});

afterAll(() => {
  rmSync(TEST_HIVE_HOME, { recursive: true, force: true });
});

describe("catalog notification real AgentManager application E2E", () => {
  it("persists real manager sessions and telemetry without transferring notifier ownership", async () => {
    const memoryWrites = vi.fn().mockResolvedValue(undefined);
    const memoryManager = {
      read: vi.fn().mockResolvedValue(null),
      list: vi.fn().mockResolvedValue([]),
      write: memoryWrites,
    } as unknown as MemoryManager;
    const claudeRun = vi.spyOn(ClaudeAgentAdapter.prototype, "runTurn");
    activeSpies.push(claudeRun);

    harness = await createCatalogNotificationHarness({
      installExternalFetch,
      discover: async (provider) => {
        if (provider === "claude") {
          return [{ id: "claude-seed", displayName: "Claude Seed" }];
        }
        throw new CatalogError(safeError(provider, "auth"));
      },
      createAgentManager: async ({ db, registry }) => {
        sessionStore = new SessionStore(db);
        await sessionStore.init();
        telemetryStore = new TurnTelemetryStore(db);
        await telemetryStore.init();

        const sessionWrites = observeWrites(sessionStore.set.bind(sessionStore));
        const telemetryWrites = observeWrites(telemetryStore.record.bind(telemetryStore));
        activeSpies.push(
          vi.spyOn(sessionStore, "set").mockImplementation(sessionWrites.call),
          vi.spyOn(telemetryStore, "record").mockImplementation(telemetryWrites.call),
        );
        drainPersistence = async () => {
          const results = await Promise.allSettled([sessionWrites.drain(), telemetryWrites.drain()]);
          const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
          if (failed) throw failed.reason;
        };

        manager = new AgentManager(registry, memoryManager, sessionStore, db, telemetryStore);
        return manager;
      },
    });
    if (!manager || !sessionStore || !telemetryStore || !drainPersistence) {
      throw new Error("Real AgentManager fixture was not constructed");
    }

    const runWorkItemTurn = vi.spyOn(manager, "runWorkItemTurn");
    const spawnTurn = vi.spyOn(manager, "spawnTurn");
    activeSpies.push(runWorkItemTurn, spawnTurn);
    const assignmentsBefore = await assignmentState(harness.db);

    await harness.scanner.tick();
    await harness.notifier.tick();
    await drainPersistence();

    const firstChanges = await harness.db
      .collection<CatalogChangeDoc>(CHANGES)
      .find()
      .sort({ createdAt: 1, _id: 1 })
      .toArray();
    expect(firstChanges).toHaveLength(1);
    const first = firstChanges[0]!;
    const firstWorkItem = runWorkItemTurn.mock.calls[0]?.[1] as WorkItem;
    const firstContext = spawnTurn.mock.calls[0]?.[0] as TurnContext;

    expect(runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(spawnTurn).toHaveBeenCalledTimes(1);
    expect(claudeRun).toHaveBeenCalledTimes(1);
    expect(runnerConstructed).toHaveBeenCalledTimes(1);
    expect(runnerConstructed.mock.calls[0]?.[0]).toMatchObject({
      id: "chief-of-staff",
      model: "haiku",
      effort: "low",
      isDefault: true,
      homeBase: "CNOTICE1",
    });
    expect(firstWorkItem).toMatchObject({
      id: `catalog-change:${first._id}`,
      sender: "system",
      threadId: expect.stringMatching(new RegExp(`^catalog-change:${first._id}:`)),
      source: { kind: "slack", id: "CNOTICE1", label: "CNOTICE1", adapterId: "slack" },
      meta: {
        systemNotification: "catalog-change",
        catalogCommitId: first._id,
        targetAgentId: "chief-of-staff",
      },
    });
    expect(firstContext).toMatchObject({
      agentId: "chief-of-staff",
      sessionId: undefined,
      channelId: "CNOTICE1",
      threadId: firstWorkItem.threadId,
      workItem: firstWorkItem,
      channel: "slack",
    });
    expect(runnerSend).toHaveBeenCalledWith(
      firstWorkItem.text,
      undefined,
      undefined,
      {
        adapterId: "slack",
        channelId: "CNOTICE1",
        channelKind: "slack",
        channelLabel: "CNOTICE1",
        threadId: firstWorkItem.threadId,
        slackTs: "",
        slackThreadTs: "",
      },
      undefined,
      undefined,
      undefined,
      undefined,
    );
    expect(runnerBuildProviderPrompt).not.toHaveBeenCalled();
    expect(memoryWrites).not.toHaveBeenCalled();
    expect(conversationIndexRecord).toHaveBeenCalledTimes(1);

    const firstSession = await harness.db.collection<SessionDocument>(SESSIONS).findOne({
      _id: `chief-of-staff:${firstWorkItem.threadId}`,
    });
    expect(firstSession).toMatchObject({
      agentId: "chief-of-staff",
      threadId: firstWorkItem.threadId,
      sessionId: "catalog-test-session",
      provider: "claude",
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      contextWindow: 200_000,
      compactions: 0,
      createdAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    const firstTelemetry = await harness.db.collection<TurnTelemetryDoc>(TELEMETRY).find().toArray();
    expect(firstTelemetry).toHaveLength(1);
    expect(firstTelemetry[0]).toMatchObject({
      agentId: "chief-of-staff",
      threadId: firstWorkItem.threadId,
      sessionId: "catalog-test-session",
      model: "haiku",
      inputTokens: 20,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      durationMs: 20,
      llmMs: 15,
      toolMs: 0,
      toolCalls: 0,
      resumedSession: false,
      createdAt: expect.any(Date),
    });
    expect(first.delivery).toMatchObject({
      state: "delivered",
      attempts: 1,
      preparation: {
        binding: {
          agentId: "chief-of-staff",
          homeBase: "CNOTICE1",
          adapterId: "slack",
          channelId: "CNOTICE1",
        },
        text: harness.posts[0]?.text,
        processedAt: expect.any(Date),
      },
      receipt: {
        preparationId: first.delivery.preparation?.id,
        binding: first.delivery.preparation?.binding,
        channelId: "CNOTICE1",
        messageTs: "1900000000.000001",
        acknowledgedAt: expect.any(Date),
      },
    });
    expect(harness.posts).toEqual([
      {
        channel: "CNOTICE1",
        text: first.delivery.preparation?.text,
        returned: { ok: true, channel: "CNOTICE1", ts: "1900000000.000001" },
      },
    ]);

    await expect(
      harness.manual({
        provider: "claude",
        models: [
          { id: "claude-seed", displayName: "Claude Seed" },
          { id: "claude-next", displayName: "Claude Next" },
        ],
        changeSummary: "add a second Claude model",
      }),
    ).resolves.toMatchObject({ content: [{ text: expect.stringContaining("+1 (claude-next), -0") }] });
    await harness.notifier.tick();
    await drainPersistence();

    const secondChanges = await harness.db.collection<CatalogChangeDoc>(CHANGES).find().sort({ revision: 1 }).toArray();
    expect(secondChanges).toHaveLength(2);
    const second = secondChanges[1]!;
    const secondWorkItem = runWorkItemTurn.mock.calls[1]?.[1] as WorkItem;
    const secondContext = spawnTurn.mock.calls[1]?.[0] as TurnContext;
    expect(runWorkItemTurn).toHaveBeenCalledTimes(2);
    expect(spawnTurn).toHaveBeenCalledTimes(2);
    expect(claudeRun).toHaveBeenCalledTimes(2);
    expect(runnerConstructed).toHaveBeenCalledTimes(2);
    expect(runnerSend).toHaveBeenCalledTimes(2);
    expect(secondWorkItem).toMatchObject({
      id: `catalog-change:${second._id}`,
      sender: "system",
      meta: { catalogCommitId: second._id, targetAgentId: "chief-of-staff" },
    });
    expect(secondWorkItem.threadId).not.toBe(firstWorkItem.threadId);
    expect(secondContext.threadId).toBe(secondWorkItem.threadId);
    expect(secondContext.sessionId).toBeUndefined();
    expect(runnerSend.mock.calls[1]?.[0]).toBe(secondWorkItem.text);
    expect(runnerSend.mock.calls[1]?.[1]).toBeUndefined();

    const sessions = await harness.db.collection<SessionDocument>(SESSIONS).find().sort({ threadId: 1 }).toArray();
    expect(sessions).toHaveLength(2);
    expect(new Set(sessions.map((session) => session.threadId))).toEqual(
      new Set([firstWorkItem.threadId!, secondWorkItem.threadId!]),
    );
    expect(sessions.map((session) => session._id).sort()).toEqual(
      [`chief-of-staff:${firstWorkItem.threadId}`, `chief-of-staff:${secondWorkItem.threadId}`].sort(),
    );
    expect(sessions.every((session) => session.sessionId === "catalog-test-session")).toBe(true);
    const telemetry = await harness.db.collection<TurnTelemetryDoc>(TELEMETRY).find().sort({ threadId: 1 }).toArray();
    expect(telemetry).toHaveLength(2);
    expect(new Set(telemetry.map((entry) => entry.threadId))).toEqual(
      new Set([firstWorkItem.threadId!, secondWorkItem.threadId!]),
    );
    expect(telemetry.every((entry) => entry.sessionId === "catalog-test-session" && entry.model === "haiku")).toBe(
      true,
    );
    expect(second.delivery).toMatchObject({
      state: "delivered",
      attempts: 1,
      preparation: { text: harness.posts[1]?.text },
      receipt: {
        preparationId: second.delivery.preparation?.id,
        channelId: "CNOTICE1",
        messageTs: "1900000000.000002",
      },
    });
    expect(await assignmentState(harness.db)).toEqual(assignmentsBefore);

    manager.stopAll();
    expect(manager.getState("chief-of-staff")?.status).toBe("stopped");
    await expect(
      harness.manual({
        provider: "claude",
        models: [
          { id: "claude-seed", displayName: "Claude Seed" },
          { id: "claude-next", displayName: "Claude Next" },
          { id: "claude-third", displayName: "Claude Third" },
        ],
        changeSummary: "add a third Claude model",
      }),
    ).resolves.toMatchObject({ content: [{ text: expect.stringContaining("+1 (claude-third), -0") }] });
    await harness.notifier.tick();
    await drainPersistence();

    const allChanges = await harness.db.collection<CatalogChangeDoc>(CHANGES).find().sort({ revision: 1 }).toArray();
    expect(allChanges).toHaveLength(3);
    expect(allChanges[2]?.delivery).toMatchObject({
      state: "pending",
      attempts: 1,
      diagnostic: { reason: "turn-failed", at: expect.any(Date) },
    });
    expect(allChanges[2]?.delivery.preparation).toBeUndefined();
    expect(runWorkItemTurn).toHaveBeenCalledTimes(3);
    expect(spawnTurn).toHaveBeenCalledTimes(3);
    expect(runnerSend).toHaveBeenCalledTimes(2);
    expect(claudeRun).toHaveBeenCalledTimes(2);
    expect(harness.posts).toHaveLength(2);
    expect(await harness.db.collection(SESSIONS).countDocuments()).toBe(2);
    expect(await harness.db.collection(TELEMETRY).countDocuments()).toBe(2);
    expect(await assignmentState(harness.db)).toEqual(assignmentsBefore);
  }, 20_000);
});
