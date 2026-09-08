import { existsSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";

const execState = vi.hoisted(() => ({
  calls: [] as Array<{ command: string; args: string[]; options: Record<string, unknown> }>,
  error: undefined as unknown,
  stdout: "codex-cli 1.2.3",
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const execFile = Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: async (
      command: string,
      args: string[],
      options: Record<string, unknown>,
    ) => {
      execState.calls.push({ command, args, options });
      if (execState.error) throw execState.error;
      return { stdout: execState.stdout, stderr: "" };
    },
  });
  return { ...actual, execFile };
});

import {
  claudeEnvironment,
  createModelCatalogDiscovery,
  normalizeProvider,
  validateClaudeAccount,
  type DiscoveryDependencies,
} from "./model-catalog-discovery.js";

const signal = () => new AbortController().signal;
const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    ...init,
    headers: { "content-type": "application/json", ...init.headers },
  });
const model = (value = "alias", resolvedModel: string | undefined = "model-1") => ({
  value,
  displayName: "Model One",
  ...(resolvedModel === undefined ? {} : { resolvedModel }),
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

type ClaudeStart = {
  promise: Promise<unknown>;
  next?: Promise<IteratorResult<never>>;
  close: ReturnType<typeof vi.fn>;
  accountInfo: ReturnType<typeof vi.fn>;
  supportedModels: ReturnType<typeof vi.fn>;
  query: ReturnType<typeof vi.fn>;
  args?: Parameters<NonNullable<DiscoveryDependencies["query"]>>[0];
  emitted: () => boolean;
};

function startClaude(
  options: {
    env?: NodeJS.ProcessEnv;
    account?: unknown;
    accountInfo?: () => Promise<unknown>;
    models?: unknown;
    supportedModels?: () => Promise<unknown>;
    constructError?: unknown;
    externalSignal?: AbortSignal;
    now?: () => number;
  } = {},
): ClaudeStart {
  const close = vi.fn();
  const accountInfo = vi.fn(
    options.accountInfo ??
      (async () =>
        options.account !== undefined ? options.account : initializationAccount({ subscription: "Claude Pro" })),
  );
  const supportedModels = vi.fn(options.supportedModels ?? (async () => options.models ?? [model()]));
  let next: Promise<IteratorResult<never>> | undefined;
  let argsSeen: Parameters<NonNullable<DiscoveryDependencies["query"]>>[0] | undefined;
  let emitted = false;
  const query = vi.fn((args: Parameters<NonNullable<DiscoveryDependencies["query"]>>[0]) => {
    argsSeen = args;
    const iterator = args.prompt[Symbol.asyncIterator]();
    next = iterator.next();
    void next.then((result) => {
      if (!result.done) emitted = true;
    });
    if (options.constructError) throw options.constructError;
    return { accountInfo, supportedModels, close } as never;
  });
  const discover = createModelCatalogDiscovery({
    env: options.env ?? {},
    now: options.now,
    query: query as NonNullable<DiscoveryDependencies["query"]>,
  });
  const promise = discover("claude", { signal: options.externalSignal ?? signal() });
  return {
    promise,
    get next() {
      return next;
    },
    close,
    accountInfo,
    supportedModels,
    query,
    get args() {
      return argsSeen;
    },
    emitted: () => emitted,
  };
}

async function expectClaudeCleanup(run: ClaudeStart, closeCount = 1) {
  expect(run.emitted()).toBe(false);
  await expect(run.next).resolves.toEqual({ value: undefined, done: true });
  expect(run.emitted()).toBe(false);
  expect(run.close).toHaveBeenCalledTimes(closeCount);
}

// SDK 0.3.258 / bundled CLI 2.1.258: initialization.account maps the CLI's
// mutually exclusive internal `subscription` else `tokenSource` fields this way.
const initializationAccount = (internal: Record<string, unknown>, apiProvider = "firstParty") => ({
  email: internal.email,
  organization: internal.organization,
  subscriptionType: internal.subscription,
  tokenSource: internal.tokenSource,
  apiKeySource: internal.apiKeySource,
  apiProvider,
});
const acceptedAccounts = [
  ...["Claude Pro", "Claude Max", "Claude Team", "Claude Enterprise"].map((subscription) => ({
    env: {},
    account: initializationAccount({ subscription }),
  })),
  {
    env: { CLAUDE_CODE_OAUTH_TOKEN: "test-secret" },
    account: initializationAccount({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }),
  },
];

function codexDeps(overrides: DiscoveryDependencies = {}) {
  const codexToken = vi.fn(() => async () => "test-secret");
  const fetch = vi.fn(async () =>
    json({ models: [{ slug: "gpt-5", display_name: "GPT-5", visibility: "list", priority: 1 }] }),
  );
  const version = vi.fn(async () => "codex-cli 1.2.3");
  return {
    deps: { env: { HOME: "/service" }, codexToken, fetch: fetch as typeof globalThis.fetch, version, ...overrides },
    codexToken,
    fetch,
    version,
  };
}

function grokDeps(overrides: DiscoveryDependencies = {}) {
  const grokToken = vi.fn(async () => "test-secret");
  const fetch = vi.fn(async () => json({ data: [{ id: "grok-1", name: "Grok 1" }] }));
  return {
    deps: { grokToken, fetch: fetch as typeof globalThis.fetch, ...overrides },
    grokToken,
    fetch,
  };
}

afterEach(() => {
  vi.useRealTimers();
  execState.calls.length = 0;
  execState.error = undefined;
  execState.stdout = "codex-cli 1.2.3";
});

describe("Claude subscription environment and account evidence", () => {
  it("removes every known and future alternate-auth selector while retaining the service environment", () => {
    const excluded = [
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_AUTH_TOKEN",
      "ANTHROPIC_BASE_URL",
      "ANTHROPIC_PROFILE",
      "ANTHROPIC_FEDERATION_RULE_ID",
      "ANTHROPIC_ORGANIZATION_ID",
      "ANTHROPIC_IDENTITY_TOKEN",
      "ANTHROPIC_IDENTITY_TOKEN_FILE",
      "ANTHROPIC_CUSTOM_HEADERS",
      "CLAUDE_API_KEY",
      "CLAUDE_CODE_API_BASE_URL",
      "_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL",
      "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CCR_OAUTH_TOKEN_FILE",
      "CLAUDE_BG_AUTH_SNAPSHOT_PATH",
      "CLAUDE_BG_DISPATCHER_SUBSCRIPTION_TYPE",
      "CLAUDE_CODE_SUBSCRIPTION_TYPE",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_FOUNDRY",
      "CLAUDE_CODE_USE_VERTEX",
      "CLAUDE_CODE_USE_ANTHROPIC_AWS",
      "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
      "CLAUDE_CODE_USE_MANTLE",
      "CLAUDE_CODE_USE_GATEWAY",
      "CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR",
      "CLAUDE_CODE_HOST_AUTH_ENV_VAR",
      "CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST",
      "CLAUDE_CODE_CUSTOM_OAUTH_URL",
      "CLAUDE_CODE_USE_FUTURE_BACKEND",
      "ANTHROPIC_FUTURE_SELECTOR",
      "_CLAUDE_FUTURE_SELECTOR",
      "CCR_FUTURE_SELECTOR",
      "CLAUDECODE",
      "OPENAI_API_KEY",
      "XAI_API_KEY",
      "GROK_API_KEY",
    ];
    const source = Object.fromEntries(excluded.map((key) => [key, `secret-${key}`]));
    Object.assign(source, {
      HOME: "/service",
      PATH: "/bin",
      LANG: "en_US.UTF-8",
      NODE_OPTIONS: "--enable-source-maps",
      CLAUDE_CONFIG_DIR: "/service/.claude",
      CLAUDE_CODE_OAUTH_TOKEN: "test-secret",
    });

    const clean = claudeEnvironment(source);

    for (const key of excluded) expect(clean).not.toHaveProperty(key);
    expect(clean).toEqual({
      HOME: "/service",
      PATH: "/bin",
      LANG: "en_US.UTF-8",
      NODE_OPTIONS: "--enable-source-maps",
      CLAUDE_CONFIG_DIR: "/service/.claude",
      CLAUDE_CODE_OAUTH_TOKEN: "test-secret",
    });
    expect(source.ANTHROPIC_API_KEY).toBe("secret-ANTHROPIC_API_KEY");
  });

  it.each(["", "   "])("drops a blank configured OAuth token (%j)", (value) => {
    expect(claudeEnvironment({ CLAUDE_CODE_OAUTH_TOKEN: value })).toEqual({});
  });

  it.each(acceptedAccounts)("accepts source-grounded account fixture %#", async ({ env, account }) => {
    const run = startClaude({ env, account });
    await expect(run.promise).resolves.toEqual([{ id: "model-1", displayName: "Model One" }]);
    expect(run.accountInfo).toHaveBeenCalledBefore(run.supportedModels);
    await expectClaudeCleanup(run);
  });

  const invalidAccounts: Array<[string, NodeJS.ProcessEnv, unknown]> = [
    ...["pro", "max", "team", "enterprise", "Claude API", "", "unknown"].map(
      (subscription): [string, NodeJS.ProcessEnv, unknown] => [
        `subscription ${JSON.stringify(subscription)}`,
        {},
        initializationAccount({ subscription }),
      ],
    ),
    ["firstParty alone", {}, initializationAccount({})],
    [
      "both subscription and source",
      {},
      initializationAccount({ subscription: "Claude Pro", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }),
    ],
    ...[
      "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
      "CCR_OAUTH_TOKEN_FILE",
      "ANTHROPIC_AUTH_TOKEN",
      "apiKeyHelper",
      "profile",
      "none",
      "future-source",
      "",
    ].map((tokenSource): [string, NodeJS.ProcessEnv, unknown] => [
      `unsupported token source ${JSON.stringify(tokenSource)}`,
      {},
      initializationAccount({ tokenSource }),
    ]),
    ["null subscription", {}, initializationAccount({ subscription: null })],
    ["numeric subscription", {}, initializationAccount({ subscription: 42 })],
    ["null token source", {}, initializationAccount({ tokenSource: null })],
    ["numeric token source", {}, initializationAccount({ tokenSource: 42 })],
    ["non-first-party", {}, initializationAccount({ subscription: "Claude Pro" }, "bedrock")],
    ["null account", {}, null],
    ["array account", {}, []],
    [
      "configured token with stored shape",
      { CLAUDE_CODE_OAUTH_TOKEN: "test-secret" },
      initializationAccount({ subscription: "Claude Pro" }),
    ],
    ["stored route with configured source", {}, initializationAccount({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" })],
    [
      "configured token with null source",
      { CLAUDE_CODE_OAUTH_TOKEN: "test-secret" },
      initializationAccount({ tokenSource: null }),
    ],
    [
      "configured token with blank source",
      { CLAUDE_CODE_OAUTH_TOKEN: "test-secret" },
      initializationAccount({ tokenSource: "" }),
    ],
    [
      "configured token with numeric source",
      { CLAUDE_CODE_OAUTH_TOKEN: "test-secret" },
      initializationAccount({ tokenSource: 7 }),
    ],
    ["api key source", {}, initializationAccount({ subscription: "Claude Pro", apiKeySource: "ANTHROPIC_API_KEY" })],
    ["blank API-key evidence", {}, initializationAccount({ subscription: "Claude Pro", apiKeySource: "" })],
    ["null API-key evidence", {}, initializationAccount({ subscription: "Claude Pro", apiKeySource: null })],
  ];

  it.each(invalidAccounts)("rejects %s without requesting models", async (_name, env, account) => {
    const run = startClaude({ env, account });
    await expect(run.promise).rejects.toMatchObject({ safe: { code: "auth" } });
    expect(run.supportedModels).not.toHaveBeenCalled();
    await expectClaudeCleanup(run);
  });

  it("validates account objects directly without leaking their metadata", () => {
    const account = { apiProvider: "firstParty", email: "private@example.com", organization: "secret-org" };
    let thrown: unknown;
    try {
      validateClaudeAccount(account, {});
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).not.toContain("private@example.com");
    expect(String(thrown)).not.toContain("secret-org");
  });
});

describe("Claude control-only lifecycle", () => {
  it("uses only the control query surface and a zero-message input", async () => {
    const run = startClaude();
    expect(run.emitted()).toBe(false);
    await expect(run.promise).resolves.toEqual([{ id: "model-1", displayName: "Model One" }]);
    expect(run.args?.options).toMatchObject({
      env: {},
      settingSources: [],
      tools: [],
      allowedTools: [],
      hooks: {},
      plugins: [],
      mcpServers: {},
      persistSession: false,
    });
    expect(run.args?.options.abortController).toBeInstanceOf(AbortController);
    await expectClaudeCleanup(run);
  });

  it.each([
    ["accountInfo rejection", { accountInfo: async () => Promise.reject(new Error("sdk-private-account")) }],
    ["supportedModels rejection", { supportedModels: async () => Promise.reject(new Error("sdk-private-models")) }],
    ["malformed rows", { models: [{ value: "alias", displayName: "" }] }],
    ["auth rejection", { account: initializationAccount({ subscription: "Claude API" }) }],
  ] as const)("cleans up after %s", async (_name, options) => {
    const run = startClaude(options);
    await expect(run.promise).rejects.toBeDefined();
    await expectClaudeCleanup(run);
  });

  it.each([
    ["construction", { constructError: new Error("private-construction-metadata") }],
    ["account", { accountInfo: async () => Promise.reject(new Error("private-account-metadata")) }],
    ["models", { supportedModels: async () => Promise.reject(new Error("private-model-metadata")) }],
  ] as const)("sanitizes SDK %s errors", async (_name, options) => {
    const run = startClaude(options);
    let thrown: unknown;
    try {
      await run.promise;
    } catch (error) {
      thrown = error;
    }
    expect(String(thrown)).not.toContain("private-");
    await expectClaudeCleanup(run, options === undefined || !("constructError" in options) ? 1 : 0);
  });

  it("does not let close failures replace a successful control result", async () => {
    const run = startClaude();
    run.close.mockImplementation(() => {
      throw new Error("private-close-metadata");
    });
    await expect(run.promise).resolves.toEqual([{ id: "model-1", displayName: "Model One" }]);
    await expectClaudeCleanup(run);
  });

  it("releases input when query construction throws and has no handle to close", async () => {
    const run = startClaude({ constructError: new Error("sdk-private-construction") });
    await expect(run.promise).rejects.toMatchObject({ safe: { code: "malformed" } });
    await expectClaudeCleanup(run, 0);
  });

  it("times out the whole operation at 60 seconds and closes the handle", async () => {
    vi.useFakeTimers();
    const pending = deferred<unknown>();
    const run = startClaude({ accountInfo: () => pending.promise });
    const assertion = expect(run.promise).rejects.toMatchObject({ safe: { code: "timeout" } });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    await expectClaudeCleanup(run);
    pending.reject(new Error("late-sdk-secret"));
  });

  it("cancels externally, aborts the SDK controller, and rejects late completion", async () => {
    const pending = deferred<unknown>();
    const external = new AbortController();
    const run = startClaude({ accountInfo: () => pending.promise, externalSignal: external.signal });
    external.abort();
    await expect(run.promise).rejects.toMatchObject({ safe: { code: "canceled" } });
    expect(run.args?.options.abortController.signal.aborted).toBe(true);
    await expectClaudeCleanup(run);
    pending.resolve(initializationAccount({ subscription: "Claude Pro" }));
    await Promise.resolve();
    expect(run.supportedModels).not.toHaveBeenCalled();
  });

  it("rejects an already-aborted signal before constructing a query", async () => {
    const external = new AbortController();
    external.abort();
    const run = startClaude({ externalSignal: external.signal });
    await expect(run.promise).rejects.toMatchObject({ safe: { code: "canceled" } });
    expect(run.query).not.toHaveBeenCalled();
    expect(run.close).not.toHaveBeenCalled();
  });
});

describe("Claude model normalization", () => {
  it("uses canonical IDs, falls back to values, preserves order, and ignores metadata", () => {
    expect(
      normalizeProvider("claude", [
        { value: "latest", resolvedModel: "claude-3", displayName: "Claude 3", description: "ignored" },
        { value: "legacy", displayName: "Legacy", capabilities: { ignored: true } },
      ]),
    ).toEqual([
      { id: "claude-3", displayName: "Claude 3" },
      { id: "legacy", displayName: "Legacy" },
    ]);
  });

  it("collapses distinct resolved aliases to the first display name", () => {
    expect(
      normalizeProvider("claude", [
        { value: "sonnet", resolvedModel: "claude-sonnet-4", displayName: "Sonnet" },
        { value: "sonnet-latest", resolvedModel: "claude-sonnet-4", displayName: "Sonnet Latest" },
      ]),
    ).toEqual([{ id: "claude-sonnet-4", displayName: "Sonnet" }]);
  });

  it.each([
    [
      "repeated unresolved ID",
      [
        { value: "same", displayName: "One" },
        { value: "same", displayName: "Two" },
      ],
    ],
    ["duplicate alias", [model("same", "one"), model("same", "two")]],
    [
      "mixed unresolved/resolved collision",
      [{ value: "canonical", displayName: "Canonical" }, model("alias", "canonical")],
    ],
    [
      "mixed resolved/unresolved collision",
      [model("alias", "canonical"), { value: "canonical", displayName: "Canonical" }],
    ],
    ["non-string resolvedModel", [{ value: "alias", resolvedModel: 3, displayName: "Name" }]],
    ["whitespace ID", [{ value: " alias ", displayName: "Name" }]],
    ["blank name", [{ value: "alias", displayName: "" }]],
    ["non-object row", ["alias"]],
  ])("rejects %s", (_name, rows) => {
    expect(() => normalizeProvider("claude", rows)).toThrow(/malformed|Duplicate/);
  });

  it("rejects an empty result", () => {
    expect(() => normalizeProvider("claude", [])).toThrow(/empty/);
  });
});

describe("Codex subscription catalog", () => {
  it("uses the exact endpoint, bearer, env, method, and configured command/auth path", async () => {
    const { deps, codexToken, fetch, version } = codexDeps({
      codexAuthPath: "/service/auth.json",
      codexRefreshCommand: "/custom/codex",
    });
    const discover = createModelCatalogDiscovery(deps);
    await expect(discover("codex", { signal: signal() })).resolves.toEqual([{ id: "gpt-5", displayName: "GPT-5" }]);
    expect(version).toHaveBeenCalledWith("/custom/codex", expect.any(AbortSignal), { HOME: "/service" });
    expect(codexToken).toHaveBeenCalledWith({
      authPath: "/service/auth.json",
      refreshCommand: "/custom/codex",
      env: { HOME: "/service" },
    });
    expect(fetch).toHaveBeenCalledWith(
      "https://chatgpt.com/backend-api/codex/models?client_version=1.2.3",
      expect.objectContaining({
        method: "GET",
        headers: { Authorization: "Bearer test-secret", Accept: "application/json" },
        redirect: "error",
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it("uses one resolved bundled/PATH command for default version and refresh", async () => {
    const expected = existsSync("/Applications/Codex.app/Contents/Resources/codex")
      ? "/Applications/Codex.app/Contents/Resources/codex"
      : "codex";
    const { deps, codexToken, version } = codexDeps();
    await createModelCatalogDiscovery(deps)("codex", { signal: signal() });
    expect(version.mock.calls[0][0]).toBe(expected);
    expect(codexToken.mock.calls[0][0]).toEqual({
      authPath: undefined,
      refreshCommand: expected,
      env: { HOME: "/service" },
    });
  });

  it("encodes an exact prerelease/build semver in the endpoint", async () => {
    const { deps, fetch } = codexDeps({ version: async () => "codex 1.2.3-beta.1+build.5" });
    await createModelCatalogDiscovery(deps)("codex", { signal: signal() });
    expect(fetch.mock.calls[0][0]).toBe(
      "https://chatgpt.com/backend-api/codex/models?client_version=1.2.3-beta.1%2Bbuild.5",
    );
  });

  it("executes --version with a five-second child bound", async () => {
    const { deps } = codexDeps({ version: undefined });
    await createModelCatalogDiscovery(deps)("codex", { signal: signal() });
    expect(execState.calls).toHaveLength(1);
    expect(execState.calls[0]).toMatchObject({ args: ["--version"], options: { timeout: 5_000, maxBuffer: 65_536 } });
    expect(execState.calls[0].options.signal).toBeInstanceOf(AbortSignal);
  });

  it.each(["", "codex-cli unknown", "codex-cli 1.2", "secret-output"])(
    "fails safely for missing/unparseable version %j",
    async (output) => {
      const { deps, codexToken, fetch } = codexDeps({ version: async () => output });
      await expect(createModelCatalogDiscovery(deps)("codex", { signal: signal() })).rejects.toMatchObject({
        safe: { code: "client-version" },
      });
      expect(codexToken).not.toHaveBeenCalled();
      expect(fetch).not.toHaveBeenCalled();
    },
  );

  it("sanitizes a failing version command", async () => {
    const { deps } = codexDeps({
      version: async () => Promise.reject(new Error("private-version-output test-secret")),
    });
    await expect(createModelCatalogDiscovery(deps)("codex", { signal: signal() })).rejects.not.toThrow(
      /private-version-output|test-secret/,
    );
  });

  it.each([
    ["missing provider", vi.fn(() => null)],
    [
      "provider construction error",
      vi.fn(() => {
        throw new Error("raw-auth-construction test-secret");
      }),
    ],
    ["provider rejection", vi.fn(() => async () => Promise.reject(new Error("raw-auth-rejection test-secret")))],
    ["blank token", vi.fn(() => async () => "   ")],
  ])("fails safely for %s without fetching", async (_name, codexToken) => {
    const { deps, fetch } = codexDeps({ codexToken: codexToken as never });
    let thrown: unknown;
    try {
      await createModelCatalogDiscovery(deps)("codex", { signal: signal() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ safe: { code: "auth" } });
    expect(String(thrown)).not.toMatch(/raw-auth|test-secret/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("filters visibility, retains supported_in_api false, and sorts integer priority with lexical ties", async () => {
    const body = {
      models: [
        { slug: "z", display_name: "Z", visibility: "list", priority: 2, supported_in_api: false },
        { slug: "b", display_name: "B", visibility: "list", priority: 1 },
        { slug: "a", display_name: "A", visibility: "list", priority: 1 },
        { visibility: "hide" },
        { visibility: "none" },
      ],
    };
    const { deps } = codexDeps({ fetch: vi.fn(async () => json(body)) as unknown as typeof fetch });
    await expect(createModelCatalogDiscovery(deps)("codex", { signal: signal() })).resolves.toEqual([
      { id: "a", displayName: "A" },
      { id: "b", displayName: "B" },
      { id: "z", displayName: "Z" },
    ]);
  });

  it.each([
    ["missing visibility", { slug: "x", display_name: "X", priority: 1 }],
    ["unknown visibility", { slug: "x", display_name: "X", visibility: "future", priority: 1 }],
    ["missing priority", { slug: "x", display_name: "X", visibility: "list" }],
    ["fractional priority", { slug: "x", display_name: "X", visibility: "list", priority: 1.5 }],
    ["infinite priority", { slug: "x", display_name: "X", visibility: "list", priority: Infinity }],
    ["missing slug", { display_name: "X", visibility: "list", priority: 1 }],
    ["missing display name", { slug: "x", visibility: "list", priority: 1 }],
  ])("rejects %s", async (_name, row) => {
    const { deps } = codexDeps({
      fetch: vi.fn(async () => json({ models: [row] })) as unknown as typeof fetch,
    });
    await expect(createModelCatalogDiscovery(deps)("codex", { signal: signal() })).rejects.toMatchObject({
      safe: { code: "malformed" },
    });
  });

  it("rejects duplicate eligible IDs", () => {
    const row = { slug: "same", display_name: "Same", visibility: "list", priority: 1 };
    expect(() => normalizeProvider("codex", { models: [row, row] })).toThrow(/Duplicate/);
  });

  it("rejects a catalog with no eligible models", () => {
    expect(() => normalizeProvider("codex", { models: [{ visibility: "hide" }] })).toThrow(/empty/);
  });

  it.each([
    ["missing models", {}],
    ["wrong models", { models: {} }],
    ["non-object row", { models: ["gpt"] }],
  ])("rejects %s container/row", (_name, body) => {
    expect(() => normalizeProvider("codex", body)).toThrow(/malformed/);
  });
});

describe("Grok subscription catalog", () => {
  it("uses the existing OAuth helper path and only the CLI proxy endpoint", async () => {
    const { deps, grokToken, fetch } = grokDeps();
    await expect(createModelCatalogDiscovery(deps)("grok", { signal: signal() })).resolves.toEqual([
      { id: "grok-1", displayName: "Grok 1" },
    ]);
    expect(grokToken).toHaveBeenCalledWith("~/.grok/auth.json");
    expect(fetch).toHaveBeenCalledWith(
      "https://cli-chat-proxy.grok.com/v1/models",
      expect.objectContaining({ headers: { Authorization: "Bearer test-secret", Accept: "application/json" } }),
    );
    expect(fetch.mock.calls.flat().join(" ")).not.toContain("api.x.ai/v1/models");
  });

  it("uses optional valid names, falls back to IDs, and sorts lexically", () => {
    expect(
      normalizeProvider("grok", {
        data: [{ id: "z" }, { id: "a", name: "Alpha", unrelated: true }],
      }),
    ).toEqual([
      { id: "a", displayName: "Alpha" },
      { id: "z", displayName: "z" },
    ]);
  });

  it("sanitizes OAuth helper errors and never fetches models", async () => {
    const { deps, fetch } = grokDeps({
      grokToken: async () => Promise.reject(new Error("raw-helper test-secret private@example.com")),
    });
    let thrown: unknown;
    try {
      await createModelCatalogDiscovery(deps)("grok", { signal: signal() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ safe: { code: "auth" } });
    expect(String(thrown)).not.toMatch(/raw-helper|test-secret|private@example.com/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects a blank helper token without fetching models", async () => {
    const { deps, fetch } = grokDeps({ grokToken: async () => "  " });
    await expect(createModelCatalogDiscovery(deps)("grok", { signal: signal() })).rejects.toMatchObject({
      safe: { code: "auth" },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("discards a late shared refresh after abort and never requests the model list", async () => {
    const token = deferred<string>();
    const external = new AbortController();
    const { deps, fetch } = grokDeps({ grokToken: () => token.promise });
    const promise = createModelCatalogDiscovery(deps)("grok", { signal: external.signal });
    external.abort();
    await expect(promise).rejects.toMatchObject({ safe: { code: "canceled" } });
    token.resolve("late-test-secret");
    await Promise.resolve();
    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("bounded strict HTTP handling", () => {
  async function discoverGrokWith(response: () => Promise<Response>) {
    const { deps } = grokDeps({ fetch: vi.fn(response) as unknown as typeof fetch });
    return createModelCatalogDiscovery(deps)("grok", { signal: signal() });
  }

  it.each(["text/plain", "application/octet-stream", ""])("rejects non-JSON content type %j", async (type) => {
    await expect(
      discoverGrokWith(async () => new Response('{"data":[]}', { headers: { "content-type": type } })),
    ).rejects.toMatchObject({ safe: { code: "malformed" } });
  });

  it("accepts a structured +json content type", async () => {
    await expect(
      discoverGrokWith(
        async () =>
          new Response('{"data":[{"id":"x"}]}', {
            headers: { "content-type": "application/vnd.vendor+json; charset=utf-8" },
          }),
      ),
    ).resolves.toEqual([{ id: "x", displayName: "x" }]);
  });

  it.each([
    ["malformed JSON", new TextEncoder().encode("{broken")],
    ["invalid UTF-8", Uint8Array.from([0xc3, 0x28])],
  ])("rejects %s", async (_name, bytes) => {
    await expect(
      discoverGrokWith(async () => new Response(bytes, { headers: { "content-type": "application/json" } })),
    ).rejects.toMatchObject({ safe: { code: "malformed" } });
  });

  it("rejects a truncated/erroring stream", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"data":['));
        controller.error(new Error("raw-stream-secret"));
      },
    });
    await expect(
      discoverGrokWith(async () => new Response(body, { headers: { "content-type": "application/json" } })),
    ).rejects.toMatchObject({ safe: { code: "malformed" } });
  });

  it.each([
    [401, "auth"],
    [403, "auth"],
    [500, "http"],
  ])("maps HTTP %i to %s without exposing the body", async (status, code) => {
    const promise = discoverGrokWith(async () => json({ error: "raw-body-test-secret" }, { status }));
    let thrown: unknown;
    try {
      await promise;
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ safe: { code, httpStatus: status } });
    expect(String(thrown)).not.toContain("raw-body-test-secret");
  });

  it("treats redirect refusal as a safe HTTP failure", async () => {
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      expect(init?.redirect).toBe("error");
      throw new TypeError("redirect carried raw-secret");
    });
    const { deps } = grokDeps({ fetch: fetch as unknown as typeof globalThis.fetch });
    let thrown: unknown;
    try {
      await createModelCatalogDiscovery(deps)("grok", { signal: signal() });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ safe: { code: "http" } });
    expect(String(thrown)).not.toContain("raw-secret");
  });

  const markers = [
    "next",
    "next_cursor",
    "nextCursor",
    "next_page_token",
    "nextPageToken",
    "next_token",
    "continuation",
    "continuationToken",
    "has_more",
    "hasMore",
  ];
  it.each(markers)("rejects pagination marker %s", async (marker) => {
    await expect(
      discoverGrokWith(async () => json({ data: [{ id: "x" }], [marker]: marker.startsWith("has") ? true : "cursor" })),
    ).rejects.toMatchObject({ safe: { code: "malformed" } });
  });

  it("rejects a links.next continuation", async () => {
    await expect(
      discoverGrokWith(async () => json({ data: [{ id: "x" }], links: { next: "cursor" } })),
    ).rejects.toMatchObject({ safe: { code: "malformed" } });
  });

  it("rejects a response above the 4 MiB raw bound", async () => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode('{"data":[{"id":"x","ignored":"'));
        controller.enqueue(encoder.encode("a".repeat(2 * 1024 * 1024)));
        controller.enqueue(encoder.encode("a".repeat(2 * 1024 * 1024 + 1)));
        controller.enqueue(encoder.encode('"}]}'));
        controller.close();
      },
    });
    await expect(
      discoverGrokWith(async () => new Response(body, { headers: { "content-type": "application/json" } })),
    ).rejects.toMatchObject({ safe: { code: "too-large" } });
  });

  it("rejects a successful JSON response without a body", async () => {
    await expect(
      discoverGrokWith(async () => new Response(null, { headers: { "content-type": "application/json" } })),
    ).rejects.toMatchObject({ safe: { code: "malformed" } });
  });

  it("rejects a normalized payload above 1 MiB", async () => {
    const largeName = "a".repeat(1024 * 1024);
    await expect(discoverGrokWith(async () => json({ data: [{ id: "x", name: largeName }] }))).rejects.toMatchObject({
      safe: { code: "too-large" },
    });
  });

  it.each([
    ["empty", { data: [] }, "empty"],
    ["missing container", {}, "malformed"],
    ["wrong container", { data: {} }, "malformed"],
    ["non-object row", { data: ["x"] }, "malformed"],
    ["blank id", { data: [{ id: "" }] }, "malformed"],
    ["padded id", { data: [{ id: " x " }] }, "malformed"],
    ["blank optional name", { data: [{ id: "x", name: "" }] }, "malformed"],
  ])("rejects %s payload", async (_name, body, code) => {
    await expect(discoverGrokWith(async () => json(body))).rejects.toMatchObject({ safe: { code } });
  });

  it("aborts the request signal on external cancellation", async () => {
    const external = new AbortController();
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const { deps } = grokDeps({ fetch: fetch as unknown as typeof globalThis.fetch });
    const promise = createModelCatalogDiscovery(deps)("grok", { signal: external.signal });
    await vi.waitFor(() => expect(fetch).toHaveBeenCalled());
    external.abort();
    await expect(promise).rejects.toMatchObject({ safe: { code: "canceled" } });
    expect(requestSignal?.aborted).toBe(true);
  });

  it("aborts the request signal at the 60-second operation deadline", async () => {
    vi.useFakeTimers();
    let requestSignal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: unknown, init?: RequestInit) => {
      requestSignal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    const { deps } = grokDeps({ fetch: fetch as unknown as typeof globalThis.fetch });
    const promise = createModelCatalogDiscovery(deps)("grok", { signal: signal() });
    const assertion = expect(promise).rejects.toMatchObject({ safe: { code: "timeout" } });
    await vi.advanceTimersByTimeAsync(60_000);
    await assertion;
    expect(requestSignal?.aborted).toBe(true);
  });

  it("applies the operation deadline after a late credential result and before fetch", async () => {
    let clock = 10;
    const token = deferred<string>();
    const { deps, fetch } = grokDeps({ grokToken: () => token.promise, now: () => clock });
    const promise = createModelCatalogDiscovery(deps)("grok", { signal: signal() });
    clock = 60_010;
    token.resolve("test-secret");
    await expect(promise).rejects.toMatchObject({ safe: { code: "timeout" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects unsupported runtime providers before any fallback", async () => {
    const fallback = vi.fn();
    await expect(
      createModelCatalogDiscovery({ fetch: fallback as unknown as typeof fetch })("gemini" as never, {
        signal: signal(),
      }),
    ).rejects.toMatchObject({ safe: { code: "malformed" } });
    expect(fallback).not.toHaveBeenCalled();
  });
});
