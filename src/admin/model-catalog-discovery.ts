import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { createCodexOpenAITokenProvider, defaultCodexCommand } from "../agents/provider-adapters/oauth-credentials.js";
import { resolveOAuthFileToken } from "../agents/provider-adapters/grok-oauth.js";
import { CatalogError, normalizedPayload, object, reject, safeError, string } from "./model-catalog-value.js";
import type { CatalogProvider, DiscoveredModel } from "./model-catalog-types.js";

const exec = promisify(execFile);
const lexical = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
type ControlQuery = Pick<Query, "accountInfo" | "supportedModels" | "close">;

export interface DiscoveryDependencies {
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  fetch?: typeof fetch;
  query?: (args: Parameters<typeof query>[0]) => ControlQuery;
  codexAuthPath?: string;
  codexRefreshCommand?: string;
  codexToken?: typeof createCodexOpenAITokenProvider;
  grokToken?: typeof resolveOAuthFileToken;
  version?: (command: string, signal: AbortSignal, env: NodeJS.ProcessEnv) => Promise<string>;
}

export function claudeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if (
      (/^(?:ANTHROPIC_|_CLAUDE_|CLAUDE_|CCR_)/.test(key) &&
        !["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"].includes(key)) ||
      ["CLAUDECODE", "OPENAI_API_KEY", "XAI_API_KEY", "GROK_API_KEY"].includes(key)
    )
      delete env[key];
  }
  if (!env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}

export function validateClaudeAccount(account: unknown, env: NodeJS.ProcessEnv): void {
  if (!account || typeof account !== "object" || Array.isArray(account)) reject("claude", "auth");
  const a = account as Record<string, unknown>,
    token = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  const labels = ["Claude Pro", "Claude Max", "Claude Team", "Claude Enterprise"];
  if (
    a.apiProvider !== "firstParty" ||
    a.apiKeySource !== undefined ||
    (token
      ? a.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN" || a.subscriptionType !== undefined
      : typeof a.subscriptionType !== "string" || !labels.includes(a.subscriptionType) || a.tokenSource !== undefined)
  )
    reject("claude", "auth");
}

function completeContainer(raw: unknown, key: string, provider: CatalogProvider): unknown[] {
  const body = object(raw, provider);
  for (const name of [
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
  ]) {
    if (body[name] !== undefined && body[name] !== null && body[name] !== false && body[name] !== "")
      reject(provider, "malformed");
  }
  if (body.links && object(body.links, provider).next) reject(provider, "malformed");
  if (!Array.isArray(body[key])) reject(provider, "malformed");
  return body[key];
}

export function normalizeProvider(provider: CatalogProvider, raw: unknown): DiscoveredModel[] {
  let rows: DiscoveredModel[];
  if (provider === "claude") {
    if (!Array.isArray(raw)) reject(provider, "malformed");
    const aliases = new Set<string>(),
      seen = new Map<string, boolean>();
    rows = [];
    for (const row of raw) {
      const x = object(row, provider),
        value = string(x.value, provider, true);
      if (aliases.has(value)) reject(provider, "malformed");
      aliases.add(value);
      if (x.resolvedModel !== undefined && typeof x.resolvedModel !== "string") reject(provider, "malformed");
      const resolved = typeof x.resolvedModel === "string" && x.resolvedModel.trim().length > 0;
      const id = resolved ? string(x.resolvedModel, provider, true) : value,
        displayName = string(x.displayName, provider);
      if (seen.has(id)) {
        if (!resolved || !seen.get(id)) reject(provider, "malformed");
        continue;
      }
      seen.set(id, resolved);
      rows.push({ id, displayName });
    }
  } else if (provider === "codex") {
    const eligible = completeContainer(raw, "models", provider).flatMap((row) => {
      const x = object(row, provider);
      if (!["list", "hide", "none"].includes(x.visibility as string)) reject(provider, "malformed");
      if (x.visibility !== "list") return [];
      if (typeof x.priority !== "number" || !Number.isFinite(x.priority) || !Number.isInteger(x.priority))
        reject(provider, "malformed");
      return [
        {
          id: string(x.slug, provider, true),
          displayName: string(x.display_name, provider),
          priority: x.priority,
        },
      ];
    });
    rows = eligible
      .sort((a, b) => a.priority - b.priority || lexical(a.id, b.id))
      .map(({ id, displayName }) => ({ id, displayName }));
  } else {
    rows = completeContainer(raw, "data", provider)
      .map((row) => {
        const x = object(row, provider),
          id = string(x.id, provider, true);
        return { id, displayName: x.name === undefined ? id : string(x.name, provider) };
      })
      .sort((a, b) => lexical(a.id, b.id));
  }
  return normalizedPayload(provider, rows);
}

async function readJson(response: Response, provider: CatalogProvider, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) {
    void response.body?.cancel().catch(() => undefined);
    throw new CatalogError(
      safeError(provider, response.status === 401 || response.status === 403 ? "auth" : "http", response.status),
    );
  }
  if (!/^(application\/json|application\/[\w.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    void response.body?.cancel().catch(() => undefined);
    reject(provider, "malformed");
  }
  const reader = response.body?.getReader();
  if (!reader) reject(provider, "malformed");
  const chunks: Uint8Array[] = [];
  let bytes = 0,
    complete = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 4 * 1024 * 1024) reject(provider, "too-large");
      chunks.push(part.value);
    }
    complete = true;
    try {
      return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
    } catch {
      reject(provider, "malformed");
    }
  } finally {
    if (!complete) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function createModelCatalogDiscovery(deps: DiscoveryDependencies = {}) {
  return async function discoverProviderModels(
    provider: CatalogProvider,
    options: { signal: AbortSignal },
  ): Promise<DiscoveredModel[]> {
    if (!["claude", "codex", "grok"].includes(provider)) reject("provider", "malformed");
    const now = deps.now ?? Date.now,
      deadline = now() + 60_000,
      controller = new AbortController();
    let queryHandle: ControlQuery | undefined,
      release = () => {},
      timedOut = false;
    const cancel = () => controller.abort();
    options.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, 60_000);
    if (options.signal.aborted) controller.abort();
    const check = () => {
      if (now() >= deadline) {
        timedOut = true;
        controller.abort();
      }
      controller.signal.throwIfAborted();
    };
    let onAbort = () => {};
    const aborted = new Promise<never>((_resolve, rejectAbort) => {
      onAbort = () => rejectAbort(new Error("aborted"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    const work = async () => {
      check();
      const env = deps.env ?? process.env;
      if (provider === "claude") {
        const clean = claudeEnvironment(env),
          released = new Promise<void>((resolve) => {
            release = resolve;
          });
        // eslint-disable-next-line require-yield -- The SDK needs an open input stream that emits zero messages.
        async function* input(): AsyncGenerator<never> {
          await released;
        }
        queryHandle = (deps.query ?? query)({
          prompt: input(),
          options: {
            env: clean,
            abortController: controller,
            settingSources: [],
            tools: [],
            allowedTools: [],
            hooks: {},
            plugins: [],
            mcpServers: {},
            persistSession: false,
          },
        });
        validateClaudeAccount(await queryHandle.accountInfo(), clean);
        check();
        const models = await queryHandle.supportedModels();
        check();
        return normalizeProvider(provider, models);
      }
      let token: string, url: string;
      if (provider === "codex") {
        const command = deps.codexRefreshCommand ?? defaultCodexCommand();
        let output: string;
        try {
          output = await (
            deps.version ??
            (async (cmd, signal, childEnv) =>
              (await exec(cmd, ["--version"], { signal, timeout: 5_000, maxBuffer: 64 * 1024, env: childEnv })).stdout)
          )(command, controller.signal, env);
        } catch {
          reject(provider, "client-version");
        }
        check();
        const version = output.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/)?.[1];
        if (!version) reject(provider, "client-version");
        try {
          const get = (deps.codexToken ?? createCodexOpenAITokenProvider)({
            authPath: deps.codexAuthPath,
            refreshCommand: command,
            env,
          });
          if (!get) reject(provider, "auth");
          token = await get();
        } catch {
          reject(provider, "auth");
        }
        url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`;
      } else {
        try {
          token = await (deps.grokToken ?? resolveOAuthFileToken)("~/.grok/auth.json");
        } catch {
          reject(provider, "auth");
        }
        url = "https://cli-chat-proxy.grok.com/v1/models";
      }
      check();
      if (typeof token !== "string" || !token.trim()) reject(provider, "auth");
      let response: Response;
      try {
        response = await (deps.fetch ?? fetch)(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
          redirect: "error",
          signal: controller.signal,
        });
      } catch {
        reject(provider, "http");
      }
      const raw = await readJson(response, provider, controller.signal);
      check();
      return normalizeProvider(provider, raw);
    };
    try {
      return await Promise.race([work(), aborted]);
    } catch (error) {
      if (timedOut) reject(provider, "timeout");
      if (options.signal.aborted) reject(provider, "canceled");
      if (error instanceof CatalogError) throw error;
      reject(provider, "malformed");
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener("abort", cancel);
      controller.signal.removeEventListener("abort", onAbort);
      release();
      try {
        queryHandle?.close();
      } catch {
        /* Cleanup must not disclose SDK metadata. */
      }
    }
  };
}

export const discoverProviderModels = createModelCatalogDiscovery();
