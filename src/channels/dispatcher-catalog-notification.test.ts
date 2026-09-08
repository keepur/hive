import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const { TEST_HIVE_HOME, ORIGINAL_HIVE_HOME, testKeychain } = vi.hoisted(() => {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { mkdtempSync } = require("node:fs");
  const { tmpdir } = require("node:os");
  const { join } = require("node:path");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const originalHiveHome = process.env.HIVE_HOME;
  const dir = mkdtempSync(join(tmpdir(), "hive-dispatcher-catalog-test-"));
  process.env.HIVE_HOME = dir;
  return {
    TEST_HIVE_HOME: dir,
    ORIGINAL_HIVE_HOME: originalHiveHome,
    testKeychain: vi.fn(() => ""),
  };
});

vi.mock("../keychain/from-keychain.js", () => ({ fromKeychain: testKeychain }));

vi.mock("../config.js", () => ({
  config: {
    instance: { id: "dispatcher-catalog-test" },
    autonomy: { externalComms: true, codeTask: false, codeAccess: false },
    modelRouter: { enabled: false },
    defaultAgent: "chief-of-staff",
    plugins: [],
    anthropic: { apiKey: "" },
    openai: { apiKey: "", agentModel: "" },
    codex: { agentModel: "" },
    gemini: { apiKey: "", agentModel: "" },
    kimi: { apiKey: "", agentModel: "" },
    deepseek: { apiKey: "", agentModel: "" },
    grok: { agentModel: "" },
    slack: { botToken: "", appToken: "", mcpToken: "", localMcpServer: false },
    slackInternal: { port: 0, authToken: "" },
    mongo: { uri: "", dbName: "dispatcher-catalog-test" },
    memory: { reflectionMinTurns: 3 },
    workflow: { enabled: false },
    toolSearch: { mode: "off", source: "default" },
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
  resolveToolSearchMode: () => ({ mode: "off", source: "default" }),
  resolveToolSearchEnv: () => "false",
}));

import { rmSync } from "node:fs";
import type { AgentManager, TurnResult } from "../agents/agent-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import {
  catalogWorkItem,
  makePreparation,
  type NoticeBinding,
  type NoticeDestination,
  type NoticeLookupGate,
  type NoticeRoute,
  type SendResult,
} from "../admin/model-catalog-notification.js";
import type { CatalogChange } from "../admin/model-catalog-types.js";
import type { HealthReporter } from "../health/health-reporter.js";
import type { RetryQueue } from "../sweeper/retry-queue.js";
import type { AgentConfig } from "../types/agent-config.js";
import type { WorkItem } from "../types/work-item.js";
import type { ChannelAdapter } from "./channel-adapter.js";
import { Dispatcher } from "./dispatcher.js";
import type { SlackAdapter } from "./slack-adapter.js";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const PROCESSED_AT = new Date("2026-09-08T17:00:00.000Z");
const CHANGE: CatalogChange = {
  _id: "commit-461",
  provider: "codex",
  revision: 8,
  snapshotId: "snapshot-8",
  createdAt: new Date("2026-09-07T20:00:00.000Z"),
  source: "discovery",
  updatedBy: "catalog-scanner",
  modelCount: 9,
  bootstrap: false,
  added: ["gpt-next"],
  removed: ["gpt-old"],
};

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return {
    id: "chief",
    name: "Chief",
    aliases: [],
    roles: [],
    model: "claude/claude-sonnet-4-6",
    channels: ["catalog-home"],
    homeBase: "catalog-home",
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
    ...overrides,
  };
}

function turn(overrides: Partial<TurnResult> = {}): TurnResult {
  return {
    finalMessage: "Reviewed the catalog change.",
    newSessionId: "session-after",
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
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeRegistry(initial: AgentConfig[]) {
  const state = { agents: initial };
  const api = {
    getAll: vi.fn(() => state.agents),
    get: vi.fn((id: string) => state.agents.find((candidate) => candidate.id === id)),
    findByOrigin: vi.fn(),
    findByChannel: vi.fn(),
    findAllByName: vi.fn(() => [] as AgentConfig[]),
    findByName: vi.fn(),
    findByKeyword: vi.fn(),
    getDefault: vi.fn(() => state.agents.find((candidate) => candidate.isDefault)),
    isPassiveChannel: vi.fn(() => false),
  };
  return { state, api };
}

function forbidden(name: string) {
  return vi.fn(() => {
    throw new Error(`forbidden generic path: ${name}`);
  });
}

function makeManager() {
  return {
    runWorkItemTurn: vi.fn(async (_agentId: string, _item: WorkItem): Promise<TurnResult> => turn()),
    spawnTurn: forbidden("spawnTurn"),
    findAgentForThread: forbidden("findAgentForThread"),
    findAgentsForThread: forbidden("findAgentsForThread"),
    getSessionStore: forbidden("getSessionStore"),
    providerFor: forbidden("providerFor"),
    turnDeadlineUpperBoundMs: forbidden("turnDeadlineUpperBoundMs"),
    circuitBreakers: { stateFor: forbidden("circuitBreakers.stateFor") },
  };
}

function makeSlackAdapter() {
  const api = {
    id: "catalog-slack",
    kind: "slack" as const,
    notificationAvailable: vi.fn((_binding?: string) => true),
    resolveNotificationChannel: vi.fn(
      async (_homeBase: string, gate: NoticeLookupGate, _binding?: string): Promise<NoticeDestination> => {
        if (!(await gate.check()) || !gate.current()) return { channelId: null };
        return { channelId: "CNOTICE" };
      },
    ),
    notificationRouteMatches: vi.fn((_route: NoticeBinding) => true),
    deliverNotificationReceipt: vi.fn(async (_route: NoticeBinding, _text: string): Promise<SendResult> => ({
      kind: "acknowledged",
      channelId: "CNOTICE",
      messageTs: "171.000001",
    })),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    deliver: vi.fn(async () => undefined),
    onProcessingStart: vi.fn(async () => undefined),
    onProcessingEnd: vi.fn(async () => undefined),
  };
  return api;
}

function makeFixture(agents: AgentConfig[] = [makeAgent()], attachSlack = true) {
  const registry = makeRegistry(agents);
  const manager = makeManager();
  const healthReporter = { formatForSlack: forbidden("healthReporter.formatForSlack") };
  const dispatcher = new Dispatcher(
    registry.api as unknown as AgentRegistry,
    manager as unknown as AgentManager,
    healthReporter as unknown as HealthReporter,
    "ordinary-default",
  );
  const slack = makeSlackAdapter();
  if (attachSlack) dispatcher.setSlackAdapter(slack as unknown as SlackAdapter);
  return { dispatcher, registry, manager, healthReporter, slack };
}

function openGate(): NoticeLookupGate {
  return { check: vi.fn(async () => true), current: vi.fn(() => true) };
}

async function currentRoute(dispatcher: Dispatcher): Promise<NoticeRoute> {
  const result = await dispatcher.resolveCatalogNotificationRoute(openGate());
  if (result.kind !== "route") throw new Error(`expected route, got ${result.reason}`);
  return result.route;
}

beforeAll(() => {
  expect(testKeychain).not.toHaveBeenCalled();
});

afterEach(() => {
  expect(testKeychain).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

afterAll(() => {
  if (ORIGINAL_HIVE_HOME === undefined) delete process.env.HIVE_HOME;
  else process.env.HIVE_HOME = ORIGINAL_HIVE_HOME;
  rmSync(TEST_HIVE_HOME, { recursive: true, force: true });
});

describe("Dispatcher catalog notification route", () => {
  it("selects the sole enabled default ahead of the explicit fallback and freezes its provenance", async () => {
    const selected = makeAgent({ id: "selected", name: "Selected CoS", homeBase: "  cos-home  " });
    const fallback = makeAgent({ id: "fallback", name: "Fallback CoS", homeBase: "fallback-home", isDefault: false });
    const fixture = makeFixture([selected, fallback]);
    fixture.dispatcher.setCatalogNotificationDefault("fallback");

    const result = await fixture.dispatcher.resolveCatalogNotificationRoute(openGate());

    expect(result).toEqual({
      kind: "route",
      route: {
        agentId: "selected",
        agentName: "Selected CoS",
        homeBase: "cos-home",
        adapterId: "catalog-slack",
        channelId: "CNOTICE",
      },
    });
    expect(fixture.slack.notificationAvailable).toHaveBeenCalledWith(undefined);
    expect(fixture.slack.resolveNotificationChannel).toHaveBeenCalledWith("cos-home", expect.any(Object), undefined);
    expect(fixture.slack.notificationRouteMatches).toHaveBeenCalledWith(result.kind === "route" ? result.route : {});
  });

  it("uses only a positively configured enabled fallback and clearing it restores fail-closed selection", async () => {
    const fixture = makeFixture([makeAgent({ isDefault: false })]);
    fixture.dispatcher.setCatalogNotificationDefault(" chief ");
    expect((await fixture.dispatcher.resolveCatalogNotificationRoute(openGate())).kind).toBe("route");

    fixture.dispatcher.setCatalogNotificationDefault(undefined);
    expect(await fixture.dispatcher.resolveCatalogNotificationRoute(openGate())).toEqual({
      kind: "unresolved",
      reason: "recipient-missing",
    });
  });

  it("fails closed for zero or multiple defaults without consulting a fallback", async () => {
    const none = makeFixture([makeAgent({ isDefault: false })]);
    expect(await none.dispatcher.resolveCatalogNotificationRoute(openGate())).toEqual({
      kind: "unresolved",
      reason: "recipient-missing",
    });
    expect(none.slack.notificationAvailable).not.toHaveBeenCalled();

    const multiple = makeFixture([
      makeAgent({ id: "one" }),
      makeAgent({ id: "two", homeBase: "other-home" }),
      makeAgent({ id: "fallback", isDefault: false }),
    ]);
    multiple.dispatcher.setCatalogNotificationDefault("fallback");
    expect(await multiple.dispatcher.resolveCatalogNotificationRoute(openGate())).toEqual({
      kind: "unresolved",
      reason: "multiple-defaults",
    });
    expect(multiple.slack.notificationAvailable).not.toHaveBeenCalled();
  });

  it.each(["deleted", "disabled"])(
    "does not fall through from a %s explicit target to a channel/name lookalike",
    async (state) => {
      const target = makeAgent({ id: "target", name: "Same Name", isDefault: false });
      const lookalike = makeAgent({
        id: "lookalike",
        name: "Same Name",
        channels: ["catalog-home"],
        homeBase: "catalog-home",
        isDefault: false,
      });
      const fixture = makeFixture(state === "deleted" ? [lookalike] : [{ ...target, disabled: true }, lookalike]);
      fixture.dispatcher.setCatalogNotificationDefault("target");

      expect(await fixture.dispatcher.resolveCatalogNotificationRoute(openGate())).toEqual({
        kind: "unresolved",
        reason: "recipient-missing",
      });
      expect(fixture.registry.api.findByChannel).not.toHaveBeenCalled();
      expect(fixture.registry.api.findByName).not.toHaveBeenCalled();
      expect(fixture.registry.api.findAllByName).not.toHaveBeenCalled();
      expect(fixture.slack.resolveNotificationChannel).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "   "])("rejects missing or blank home base %j before transport lookup", async (homeBase) => {
    const fixture = makeFixture([makeAgent({ homeBase })]);
    expect(await fixture.dispatcher.resolveCatalogNotificationRoute(openGate())).toEqual({
      kind: "unresolved",
      reason: "destination-unresolved",
    });
    expect(fixture.slack.notificationAvailable).not.toHaveBeenCalled();
    expect(fixture.slack.resolveNotificationChannel).not.toHaveBeenCalled();
  });

  it("rejects a missing adapter and an unavailable explicit bot binding", async () => {
    const missing = makeFixture([makeAgent()], false);
    expect(await missing.dispatcher.resolveCatalogNotificationRoute(openGate())).toEqual({
      kind: "unresolved",
      reason: "transport-unavailable",
    });

    const unsupported = makeFixture([makeAgent({ slackBot: "secondary" })]);
    unsupported.slack.notificationAvailable.mockReturnValue(false);
    expect(await unsupported.dispatcher.resolveCatalogNotificationRoute(openGate())).toEqual({
      kind: "unresolved",
      reason: "transport-unavailable",
    });
    expect(unsupported.slack.notificationAvailable).toHaveBeenCalledWith("secondary");
    expect(unsupported.slack.resolveNotificationChannel).not.toHaveBeenCalled();
  });

  it("preserves destination retry evidence without fabricating a route", async () => {
    const fixture = makeFixture();
    fixture.slack.resolveNotificationChannel.mockResolvedValue({
      channelId: null,
      retryAfterMs: 120_000,
      retryBlocked: true,
    });
    expect(await fixture.dispatcher.resolveCatalogNotificationRoute(openGate())).toEqual({
      kind: "unresolved",
      reason: "destination-unresolved",
      retryAfterMs: 120_000,
      retryBlocked: true,
    });
  });

  it.each(["default", "home-base", "bot-binding", "disabled", "deleted", "destination"])(
    "invalidates a completed route when its %s provenance changes",
    async (change) => {
      const selected = makeAgent();
      const replacement = makeAgent({ id: "replacement", homeBase: "replacement-home", isDefault: false });
      const fixture = makeFixture([selected, replacement]);
      const route = await currentRoute(fixture.dispatcher);

      switch (change) {
        case "default":
          selected.isDefault = false;
          replacement.isDefault = true;
          break;
        case "home-base":
          selected.homeBase = "new-home";
          break;
        case "bot-binding":
          selected.slackBot = "secondary";
          break;
        case "disabled":
          selected.disabled = true;
          break;
        case "deleted":
          fixture.registry.state.agents = [replacement];
          break;
        case "destination":
          fixture.slack.notificationRouteMatches.mockReturnValue(false);
          break;
      }

      expect(fixture.dispatcher.catalogNotificationRouteCurrent(route)).toBe(false);
    },
  );

  it("treats display-name edits and home-base whitespace as outside the frozen transport binding", async () => {
    const selected = makeAgent();
    const fixture = makeFixture([selected]);
    const route = await currentRoute(fixture.dispatcher);
    selected.name = "Renamed CoS";
    selected.homeBase = "  catalog-home  ";

    expect(fixture.dispatcher.catalogNotificationRouteCurrent(route)).toBe(true);
  });

  it.each(["gate-check", "gate-current", "default", "home-base", "bot-binding", "adapter"])(
    "aborts a frozen destination lookup after %s changes",
    async (change) => {
      const selected = makeAgent();
      const replacement = makeAgent({ id: "replacement", homeBase: "replacement-home", isDefault: false });
      const fixture = makeFixture([selected, replacement]);
      const entered = deferred<void>();
      const resume = deferred<void>();
      const gateState = { check: true, current: true };
      const gate: NoticeLookupGate = {
        check: vi.fn(async () => gateState.check),
        current: vi.fn(() => gateState.current),
      };
      fixture.slack.resolveNotificationChannel.mockImplementation(async (_homeBase, forwarded) => {
        entered.resolve();
        await resume.promise;
        if (!(await forwarded.check()) || !forwarded.current()) return { channelId: null };
        return { channelId: "CNOTICE" };
      });

      const pending = fixture.dispatcher.resolveCatalogNotificationRoute(gate);
      await entered.promise;
      switch (change) {
        case "gate-check":
          gateState.check = false;
          break;
        case "gate-current":
          gateState.current = false;
          break;
        case "default":
          selected.isDefault = false;
          replacement.isDefault = true;
          break;
        case "home-base":
          selected.homeBase = "new-home";
          break;
        case "bot-binding":
          selected.slackBot = "secondary";
          break;
        case "adapter": {
          const newAdapter = makeSlackAdapter();
          fixture.dispatcher.setSlackAdapter(newAdapter as unknown as SlackAdapter);
          break;
        }
      }
      resume.resolve();

      expect(await pending).toMatchObject({ kind: "unresolved" });
    },
  );

  it("performs a final current-route check even if a lookup implementation ignores its gate", async () => {
    const selected = makeAgent();
    const replacement = makeAgent({ id: "replacement", homeBase: "replacement-home", isDefault: false });
    const fixture = makeFixture([selected, replacement]);
    const entered = deferred<void>();
    const resume = deferred<void>();
    fixture.slack.resolveNotificationChannel.mockImplementation(async () => {
      entered.resolve();
      await resume.promise;
      return { channelId: "CNOTICE" };
    });

    const pending = fixture.dispatcher.resolveCatalogNotificationRoute(openGate());
    await entered.promise;
    selected.isDefault = false;
    replacement.isDefault = true;
    resume.resolve();

    expect(await pending).toEqual({ kind: "unresolved", reason: "recipient-changed" });
  });
});

describe("Dispatcher catalog notification preparation", () => {
  it("uses the targeted manager entry point with exactly two arguments and stable work identity", async () => {
    const selected = makeAgent();
    const fixture = makeFixture([selected]);
    const route = await currentRoute(fixture.dispatcher);
    const before = structuredClone(selected);

    const first = await fixture.dispatcher.prepareCatalogNotification(
      CHANGE,
      route,
      () => true,
      () => PROCESSED_AT,
    );
    const second = await fixture.dispatcher.prepareCatalogNotification(
      CHANGE,
      route,
      () => true,
      () => PROCESSED_AT,
    );

    expect(first).toEqual({
      kind: "prepared",
      preparation: makePreparation(CHANGE, route, "Reviewed the catalog change.", PROCESSED_AT),
    });
    expect(second).toEqual(first);
    expect(fixture.manager.runWorkItemTurn).toHaveBeenCalledTimes(2);
    for (const call of fixture.manager.runWorkItemTurn.mock.calls) {
      expect(call).toHaveLength(2);
      const [agentId, item] = call;
      expect(agentId).toBe("chief");
      expect(item).toEqual(catalogWorkItem(CHANGE, route));
      expect(item.id).toBe("catalog-change:commit-461");
      expect(item.threadId).toBe(fixture.manager.runWorkItemTurn.mock.calls[0]![1].threadId);
      expect(item.sender).toBe("system");
      expect(item.source).toEqual({
        kind: "slack",
        id: "CNOTICE",
        label: "catalog-home",
        adapterId: "catalog-slack",
      });
      expect(item.meta).toEqual({
        systemNotification: "catalog-change",
        catalogCommitId: "commit-461",
        targetAgentId: "chief",
      });
      expect(item).not.toHaveProperty("provider");
      expect(item).not.toHaveProperty("model");
      expect(item).not.toHaveProperty("effort");
    }
    expect(selected).toEqual(before);
    expect(first.kind === "prepared" ? first.preparation.binding : {}).not.toHaveProperty("agentName");
  });

  it.each([
    "",
    "   ",
    "No response requested.",
    "No response needed.",
    "No response required.",
    "No response necessary.",
    "(no response)",
    "N/A.",
  ])("turns successful silence/nonresponse %j into the same nonempty historical summary", async (reply) => {
    const fixture = makeFixture();
    const route = await currentRoute(fixture.dispatcher);
    fixture.manager.runWorkItemTurn.mockResolvedValue(turn({ finalMessage: reply }));

    const result = await fixture.dispatcher.prepareCatalogNotification(
      CHANGE,
      route,
      () => true,
      () => PROCESSED_AT,
    );
    const expected = makePreparation(CHANGE, route, "", PROCESSED_AT);

    expect(result).toEqual({ kind: "prepared", preparation: expected });
    expect(expected.text.trim()).not.toBe("");
    expect(expected.text).toContain("Historical revision; it may no longer be the latest catalog.");
    expect(expected.text).toContain("Change: commit-461");
    expect(expected.text).not.toContain("CoS response (quoted data)");
  });

  it.each([
    ["errors", { errors: ["provider failed"] }, "turn-failed"],
    ["timeout", { timedOut: true, errors: [] }, "turn-interrupted"],
    ["abort", { aborted: true, errors: [] }, "turn-interrupted"],
    ["timeout and abort", { timedOut: true, aborted: true, errors: [] }, "turn-interrupted"],
    ["interruption plus errors", { aborted: true, errors: ["provider failed"] }, "turn-interrupted"],
  ] as const)("maps a resolved %s outcome to fixed safe reason %s", async (_label, overrides, reason) => {
    const fixture = makeFixture();
    const route = await currentRoute(fixture.dispatcher);
    fixture.manager.runWorkItemTurn.mockResolvedValue(turn(overrides));
    const now = vi.fn(() => PROCESSED_AT);

    expect(await fixture.dispatcher.prepareCatalogNotification(CHANGE, route, () => true, now)).toEqual({
      kind: "unresolved",
      reason,
    });
    expect(now).not.toHaveBeenCalled();
  });

  it("maps thrown admission/provider failures to turn-failed without exposing the exception", async () => {
    const fixture = makeFixture();
    const route = await currentRoute(fixture.dispatcher);
    fixture.manager.runWorkItemTurn.mockRejectedValue(new Error("credential-bearing provider detail"));
    const now = vi.fn(() => PROCESSED_AT);

    expect(await fixture.dispatcher.prepareCatalogNotification(CHANGE, route, () => true, now)).toEqual({
      kind: "unresolved",
      reason: "turn-failed",
    });
    expect(now).not.toHaveBeenCalled();
  });

  it("checks invocation and route before starting a manager turn", async () => {
    const fixture = makeFixture();
    const route = await currentRoute(fixture.dispatcher);
    const mayStart = vi.fn(() => false);
    expect(await fixture.dispatcher.prepareCatalogNotification(CHANGE, route, mayStart, () => PROCESSED_AT)).toEqual({
      kind: "unresolved",
      reason: "recipient-changed",
    });
    expect(fixture.slack.notificationRouteMatches).toHaveBeenCalledTimes(1);
    expect(fixture.manager.runWorkItemTurn).not.toHaveBeenCalled();

    mayStart.mockReturnValue(true);
    fixture.slack.notificationRouteMatches.mockReturnValue(false);
    expect(await fixture.dispatcher.prepareCatalogNotification(CHANGE, route, mayStart, () => PROCESSED_AT)).toEqual({
      kind: "unresolved",
      reason: "recipient-changed",
    });
    expect(fixture.manager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("keeps a successful started turn as truthful evidence for its frozen old binding", async () => {
    const selected = makeAgent();
    const replacement = makeAgent({ id: "replacement", homeBase: "replacement-home", isDefault: false });
    const fixture = makeFixture([selected, replacement]);
    const route = await currentRoute(fixture.dispatcher);
    const result = deferred<TurnResult>();
    fixture.manager.runWorkItemTurn.mockReturnValue(result.promise);

    const pending = fixture.dispatcher.prepareCatalogNotification(
      CHANGE,
      route,
      () => true,
      () => PROCESSED_AT,
    );
    expect(fixture.manager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    selected.isDefault = false;
    replacement.isDefault = true;
    result.resolve(turn({ finalMessage: "Processed before the registry changed." }));

    expect(await pending).toEqual({
      kind: "prepared",
      preparation: makePreparation(CHANGE, route, "Processed before the registry changed.", PROCESSED_AT),
    });
  });
});

describe("Dispatcher prepared catalog notification send", () => {
  it.each([
    { kind: "acknowledged", channelId: "CNOTICE", messageTs: "171.000001" },
    { kind: "not-accepted", reason: "delivery-unconfirmed", retryAfterMs: 120_000 },
    { kind: "outcome-unknown", reason: "delivery-unconfirmed", retryBlocked: true },
  ] satisfies SendResult[])("returns the receipt path outcome unchanged: $kind", async (outcome) => {
    const fixture = makeFixture();
    const route = await currentRoute(fixture.dispatcher);
    const preparation = makePreparation(CHANGE, route, "processed", PROCESSED_AT);
    fixture.slack.deliverNotificationReceipt.mockResolvedValue(outcome);

    expect(await fixture.dispatcher.sendPreparedCatalogNotification(preparation, () => true)).toEqual(outcome);
    expect(fixture.slack.deliverNotificationReceipt).toHaveBeenCalledTimes(1);
    expect(fixture.slack.deliverNotificationReceipt).toHaveBeenCalledWith(preparation.binding, preparation.text);
    expect(fixture.manager.runWorkItemTurn).not.toHaveBeenCalled();
  });

  it("checks invocation and current destination before beginning the post", async () => {
    const fixture = makeFixture();
    const route = await currentRoute(fixture.dispatcher);
    const preparation = makePreparation(CHANGE, route, "processed", PROCESSED_AT);

    expect(await fixture.dispatcher.sendPreparedCatalogNotification(preparation, () => false)).toEqual({
      kind: "not-accepted",
      reason: "recipient-changed",
    });
    expect(fixture.slack.deliverNotificationReceipt).not.toHaveBeenCalled();

    fixture.slack.notificationRouteMatches.mockReturnValue(false);
    expect(await fixture.dispatcher.sendPreparedCatalogNotification(preparation, () => true)).toEqual({
      kind: "not-accepted",
      reason: "recipient-changed",
    });
    expect(fixture.slack.deliverNotificationReceipt).not.toHaveBeenCalled();
  });

  it("binds send to persisted preparation rather than the agent display name", async () => {
    const selected = makeAgent();
    const fixture = makeFixture([selected]);
    const route = await currentRoute(fixture.dispatcher);
    const preparation = makePreparation(CHANGE, route, "processed", PROCESSED_AT);
    selected.name = "Renamed after preparation";

    expect(await fixture.dispatcher.sendPreparedCatalogNotification(preparation, () => true)).toEqual({
      kind: "acknowledged",
      channelId: "CNOTICE",
      messageTs: "171.000001",
    });
    expect(fixture.slack.deliverNotificationReceipt).toHaveBeenCalledWith(preparation.binding, preparation.text);
  });

  it("keeps a valid receipt for the actual prepared binding when selection changes after post start", async () => {
    const selected = makeAgent();
    const replacement = makeAgent({ id: "replacement", homeBase: "replacement-home", isDefault: false });
    const fixture = makeFixture([selected, replacement]);
    const route = await currentRoute(fixture.dispatcher);
    const preparation = makePreparation(CHANGE, route, "processed", PROCESSED_AT);
    const started = deferred<void>();
    const response = deferred<SendResult>();
    fixture.slack.deliverNotificationReceipt.mockImplementation(async (binding, text) => {
      expect(binding).toEqual(preparation.binding);
      expect(text).toBe(preparation.text);
      started.resolve();
      return response.promise;
    });

    const pending = fixture.dispatcher.sendPreparedCatalogNotification(preparation, () => true);
    await started.promise;
    selected.isDefault = false;
    replacement.isDefault = true;
    const acknowledgment: SendResult = {
      kind: "acknowledged",
      channelId: preparation.binding.channelId,
      messageTs: "171.000099",
    };
    response.resolve(acknowledgment);

    expect(await pending).toEqual(acknowledgment);
    expect(fixture.slack.deliverNotificationReceipt).toHaveBeenCalledTimes(1);
  });
});

describe("Dispatcher catalog notification trust boundary", () => {
  it("does not enter dedup, routing, health, conference, retry, audit, outage, continuation, or direct-spawn paths", async () => {
    const fixture = makeFixture();
    const route = await currentRoute(fixture.dispatcher);
    const genericAdapter = {
      id: "audit",
      kind: "slack" as const,
      start: forbidden("audit.start"),
      stop: forbidden("audit.stop"),
      deliver: forbidden("audit.deliver"),
    };
    fixture.dispatcher.setAuditChannel(genericAdapter as unknown as ChannelAdapter, new Map([["audit", "CAUDIT"]]));
    const retry = { enqueue: forbidden("retryQueue.enqueue") };
    fixture.dispatcher.setRetryQueue(retry as unknown as RetryQueue);
    fixture.dispatcher.setOutageStateProvider(() => {
      throw new Error("forbidden generic path: outage state");
    });

    type GenericPath =
      | "dispatch"
      | "resolveAgents"
      | "tryOutageDiversion"
      | "deliverAgentResult"
      | "handleTurnFailure"
      | "maybeHandlePostTurnOutage"
      | "maybeHandleDeadlineAbort"
      | "recordTurnSuccess"
      | "dispatchToAgent"
      | "scheduleMeetingAck"
      | "triggerConferenceReactions"
      | "postAuditLog"
      | "deliverOutageNotice"
      | "routeVoiceTurn";
    const target = fixture.dispatcher as unknown as Record<GenericPath, (...args: unknown[]) => unknown>;
    const names: GenericPath[] = [
      "dispatch",
      "resolveAgents",
      "tryOutageDiversion",
      "deliverAgentResult",
      "handleTurnFailure",
      "maybeHandlePostTurnOutage",
      "maybeHandleDeadlineAbort",
      "recordTurnSuccess",
      "dispatchToAgent",
      "scheduleMeetingAck",
      "triggerConferenceReactions",
      "postAuditLog",
      "deliverOutageNotice",
      "routeVoiceTurn",
    ];
    const poisons = names.map((name) =>
      vi.spyOn(target, name).mockImplementation(() => {
        throw new Error(`forbidden generic path: ${name}`);
      }),
    );

    const prepared = await fixture.dispatcher.prepareCatalogNotification(
      CHANGE,
      route,
      () => true,
      () => PROCESSED_AT,
    );
    if (prepared.kind !== "prepared") throw new Error(`expected preparation, got ${prepared.reason}`);
    expect(await fixture.dispatcher.sendPreparedCatalogNotification(prepared.preparation, () => true)).toEqual({
      kind: "acknowledged",
      channelId: "CNOTICE",
      messageTs: "171.000001",
    });

    for (const poison of poisons) expect(poison).not.toHaveBeenCalled();
    expect(fixture.manager.spawnTurn).not.toHaveBeenCalled();
    expect(fixture.manager.findAgentForThread).not.toHaveBeenCalled();
    expect(fixture.manager.findAgentsForThread).not.toHaveBeenCalled();
    expect(fixture.manager.getSessionStore).not.toHaveBeenCalled();
    expect(fixture.manager.providerFor).not.toHaveBeenCalled();
    expect(fixture.manager.turnDeadlineUpperBoundMs).not.toHaveBeenCalled();
    expect(fixture.manager.circuitBreakers.stateFor).not.toHaveBeenCalled();
    expect(fixture.healthReporter.formatForSlack).not.toHaveBeenCalled();
    expect(genericAdapter.deliver).not.toHaveBeenCalled();
    expect(retry.enqueue).not.toHaveBeenCalled();
    const state = fixture.dispatcher as unknown as {
      recentMessageIds: Map<string, number>;
      threadAgentMap: Map<string, string>;
      threadParticipants: Map<string, Set<string>>;
      meetingReactionTracker: Map<string, unknown>;
    };
    expect(state.recentMessageIds.size).toBe(0);
    expect(state.threadAgentMap.size).toBe(0);
    expect(state.threadParticipants.size).toBe(0);
    expect(state.meetingReactionTracker.size).toBe(0);
  });

  it("does not grant a generic inbound item access to the dedicated methods through copied metadata", async () => {
    const fixture = makeFixture();
    fixture.dispatcher.registerAdapter(fixture.slack as unknown as ChannelAdapter);
    const resolve = vi.spyOn(fixture.dispatcher, "resolveCatalogNotificationRoute");
    const prepare = vi.spyOn(fixture.dispatcher, "prepareCatalogNotification");
    const send = vi.spyOn(fixture.dispatcher, "sendPreparedCatalogNotification");
    const inbound: WorkItem = {
      id: "untrusted-inbound",
      text: "ordinary inbound text",
      sender: "U123",
      source: { kind: "slack", id: "CNOTICE", label: "catalog-home", adapterId: "catalog-slack" },
      timestamp: new Date("2026-09-08T18:00:00.000Z"),
      meta: {
        systemNotification: "catalog-change",
        catalogCommitId: CHANGE._id,
        targetAgentId: "chief",
      },
    };

    await fixture.dispatcher.dispatch(inbound);

    expect(resolve).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(fixture.manager.runWorkItemTurn).toHaveBeenCalledTimes(1);
    expect(fixture.manager.runWorkItemTurn).toHaveBeenCalledWith("chief", inbound);
    expect(fixture.slack.deliver).toHaveBeenCalledTimes(1);
  });
});
