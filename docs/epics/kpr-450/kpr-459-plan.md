# KPR-459 — Subscription discovery and recoverable catalog persistence

> **For agentic workers:** Use dodi-dev:implement to execute this plan after the epic's waterfall maturity gate permits implementation.

## TL;DR

Add subscription-only discovery and one CAS-based Mongo writer shared by discovery and manual refresh. Commit the snapshot and a bounded export envelope atomically; recover history and pending changes before accepting the next replacement. Keep scanner scheduling and notice delivery in KPR-460/KPR-461.

## Key Points

- Binding specification: `docs/epics/kpr-450/kpr-459-spec.md` at `ea00e468f59caff6386ca98eb0035ce34e123d1b`; Gate 1 package is approved. No merged-sibling canon applies.
- Use the installed Claude SDK `0.3.258`, Codex subscription OAuth helper/default command, and Grok's existing refresh helper. No generation, API-key fallback, public catalog, or credentials probe.
- A thrown write can commit later. Positive operation evidence reconciles success; an immediate negative read never licenses replay or a failure claim. Unchanged discovery uses the persisted attempt UUID as its operation identity and retains token/revision fencing.
- Real Mongo tests spawn an isolated standalone WiredTiger process and use a random test database. The stateful fake supplies deterministic interleavings; real Mongo proves its CAS/uniqueness/recovery assumptions.
- Dependencies for later children are the exported discovery factory, store methods/results, scan state, recovery results, and typed change collection. No scanner timer, dispatch callback, delivery acknowledgment, or agent assignment is added here.

**Goal:** Persist deterministic subscription catalog replacements with recoverable audit/change records, and route the existing manual tool through that writer.

**Architecture:** Pure types/normalization define identity and safe errors. An injected discovery factory performs bounded control-only requests. A Mongo store uses journaled single-document CAS plus idempotent export; no session, transaction, manual lease, or second production Mongo client is needed.

**Tech Stack:** TypeScript ESM, Node 24, MongoDB driver 7.6, Claude Agent SDK 0.3.258, Vitest 4.1, existing OAuth helpers, local `mongod`.

## Testing Contract

### Required Test Groups

- Unit: **required**.
  - Scope: normalization/hash/diffs; safe errors; provider requests/auth/environment/cleanup; stateful CAS, attempt fencing, ambiguous acknowledgments, projection; admin tool compatibility.
  - Reason: vendor payloads and Mongo interleavings must fail safely without paid calls.
  - Minimum assertions: all fixture matrices in Tasks 2, 4, and 6; compare persisted documents/history/outbox, not only mock invocation counts.
- Integration: **required**.
  - Scope: real store and guard against a fresh standalone Mongo process; real manual handler plus store; injected discovery results applied through persisted attempt tokens.
  - Reason: prove unique IDs, actual filters, journaled writes, legacy migration, restart recovery, and ambiguity boundaries against Mongo rather than a permissive mock.
  - Harness: **setup-required**; implement `src/admin/testing/standalone-mongo.ts` and deterministic fault proxy. `mongod` exists at `/opt/homebrew/bin/mongod` on the reviewed machine; use `MONGOD_BINARY` or `mongod` from PATH on other hosts. A missing binary is a concrete blocker, never a skipped test.
  - Minimum assertions: two concurrent replacements, manual/discovery rebase, unchanged/manual race, lease takeover, all projection boundaries, delayed commit after negative reconciliation read, uncertain unchanged status write, unresolved UUID reentry across failed evidence/recovery reads and unavailable indexes, fresh-store recovery, initial versus reentry guard/conflict refusal, successor-token proof restoration, and standalone `hello` without `setName`.
- E2E: **not-required**.
  - Scope: scheduled engine startup, CoS routing, Slack notice delivery.
  - Reason: this child exposes primitives; KPR-460/KPR-461 own those end-to-end flows.
  - Harness: **not-applicable**.
  - Minimum assertions: none in this child; no live credentials, Slack, or paid provider calls.

### Critical Flows

- Manual first seed → journaled snapshot/envelope → one history row + one pending bootstrap change.
- Discovery claim → validated provider response → CAS against latest manual notes → success status, or unchanged status with revision guard.
- Failure/timeout/cancellation → no successful freshness or catalog/history/change mutation.
- Unknown acknowledgment → positive evidence or `commit-unknown`, never blind retry; a late mutation remains fenced.
- Crash at any export boundary → fresh store recovers exact immutable payload once; delivery fields survive duplicate recovery.

### Regression Surface

- Existing catalog list JSON/prose and `source: "curated" | "live"`; Gemini cache, key resolution, unavailable/unseeded behavior.
- Manual plugins, complete notes replacement, actor/summary/diff wording, retained/reintroduced `addedAt`.
- Existing Codex/Grok credential resolution, refresh single-flight/writeback, write-guard identity sentinel, shared Mongo pool.

### Commands

Run from the implementation worktree, not the deployment clone.

- Unit: `npx vitest run src/admin/model-catalog-value.test.ts src/admin/model-catalog-discovery.test.ts src/admin/model-catalog-store.test.ts src/admin/admin-mcp-server.test.ts`
- Integration: `npx vitest run src/admin/model-catalog-store.integration.test.ts`
- E2E: not applicable in this child.
- Adjacent regression: `npx vitest run src/agents/provider-adapters/grok-oauth.test.ts src/db/write-guard.test.ts src/db/db-identity.integration.test.ts src/admin/admin-mcp-server.test.ts`
- Broader regression: `npm run check`
- Build: `npm run build`

### Harness Requirements

- Install locked dependencies into the implementation worktree with `npm ci`; `/Users/mokie/github/hive/node_modules` was inspected read-only for planning, and must not be edited.
- Real integration harness owns its child PID, temporary data directory, loopback port, random database name and MongoClient; never accepts `MONGO_URI`, imports `config.ts`, reads `.env`, attaches to port 27017, or connects to an existing Mongo process.
- `MONGOD_BINARY` names an executable only. Do not accept a caller-supplied DB URI. Bind to `127.0.0.1`; no replica-set args; assert WiredTiger and standalone topology. Failure must close clients, terminate only the owned child, and remove only the owned temp directory.
- Default `npm run check` includes the integration file through existing `src/**/*.test.ts`; set per-suite hook/test timeouts to 30 seconds without changing the global 10-second timeout.
- Unit fake must enforce filters and unique `_id`s, clone reads/writes, apply updates atomically, support explicit before/after/deferred faults, and throw for unsupported query/update operators. No production store-specific optimistic shortcuts in the fake.
- Provider fixtures use fake tokens such as `test-secret`; assert these and raw injected bodies/errors never appear in public error messages. Intercept every provider HTTP/SDK/version dependency; no live calls.

### Non-Required Rationale

- E2E: lifecycle and actual delivery require sibling implementations and are explicitly excluded here.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.
- Run verification before completion claims/commits. After clean child review, submit through the epic workflow; this plan does not authorize deployment or final epic merge.

## File Map and Execution Order

| File | Responsibility |
| --- | --- |
| `src/admin/model-catalog-types.ts` | Shared persisted and result types; no provider SDK/config imports. |
| `src/admin/model-catalog-value.ts` | Validation, safe errors, snapshot identity and prospective document construction. |
| `src/admin/model-catalog-discovery.ts` | Injected subscription discovery, bounded HTTP/version/SDK lifecycle and environment boundary. |
| `src/admin/model-catalog-export.ts` | Idempotent immutable projection and exact-slot clearing. |
| `src/admin/model-catalog-store.ts` | CAS replacements, attempt fencing, reconciliation, state/pending queries. |
| `src/agents/provider-adapters/oauth-credentials.ts` | Export the existing `defaultCodexCommand` resolver for reuse; do not alter refresh behavior. |
| `src/admin/testing/catalog-db.test-support.ts` | Stateful fake and fault injection reused by unit/admin tests. |
| `src/admin/testing/standalone-mongo.ts` | Isolated real Mongo lifecycle, no application configuration. |
| `src/admin/model-catalog-value.test.ts` | Value invariants and size validation. |
| `src/admin/model-catalog-discovery.test.ts` | Provider/auth/source-grounded account fixtures and cleanup. |
| `src/admin/model-catalog-store.test.ts` | Deterministic persistence and fencing schedules. |
| `src/admin/model-catalog-store.integration.test.ts` | Real Mongo recovery/concurrency/guard/manual integration. |
| `src/admin/admin-mcp-server.ts`, `.test.ts` | Replace unsafe writer and old fake; preserve list behavior. |
| `docs/providers.md`, `CLAUDE.md` | Document shared semantics, auth surfaces, and durable changes. |

Tasks 1→3→4 establish shared persistence; Task 2 can execute after Task 1 independently of Tasks 3–4. Task 5 depends on 1/3/4. Task 6 completes integration/regression/docs. Keep each listed code block complete in its target file; apply the repository formatter after copying the blocks. Test matrices below define additional table-driven cases, not optional assertions.

## Task 1 — Shared types, validation, and deterministic identity

**Files:** Create `src/admin/model-catalog-types.ts`, `src/admin/model-catalog-value.ts`, `src/admin/model-catalog-value.test.ts`.

- [ ] **Step 1:** Create the shared types. `commitId` for a discovery replacement equals its caller-supplied UUID attempt ID; manual writes allocate one UUID per invocation. This is still one UUID per logical replacement and also lets uncertain unchanged status writes use the same stable operation identity. A caller must generate a fresh UUID for each new attempt and must never recycle a completed attempt token.

```ts
// src/admin/model-catalog-types.ts
export const BUILTIN_CATALOG_PROVIDERS = ["claude", "grok", "codex"] as const;
export type CatalogProvider = (typeof BUILTIN_CATALOG_PROVIDERS)[number];
export type FailureCode = "auth" | "client-version" | "http" | "timeout" | "canceled" | "malformed" | "empty" | "too-large" | "storage";
export interface SafeCatalogError { code: FailureCode; message: string; httpStatus?: number }
export interface DiscoveredModel { id: string; displayName: string }
export interface ModelInput extends DiscoveredModel { notes?: string }
export interface CatalogModel extends ModelInput { addedAt: Date }
export type CatalogSource = "manual" | "discovery";
export interface DiscoveryAttempt { provider: CatalogProvider; attemptId: string; startedAt: Date; leaseExpiresAt: Date }
export interface CatalogScan { attemptId: string; startedAt: Date; leaseExpiresAt?: Date; finishedAt?: Date; outcome: "running" | "succeeded" | "failed"; lastSucceededAt?: Date; error?: SafeCatalogError }
export interface CatalogDiff { bootstrap: boolean; added: string[]; removed: string[] }
export interface CatalogChange extends CatalogDiff { _id: string; provider: string; revision: number; snapshotId: string; createdAt: Date; source: CatalogSource; updatedBy: string; modelCount: number }
export interface ChangeDelivery { state: "pending"; attempts: number; nextAttemptAt: Date }
export interface CatalogChangeDoc extends CatalogChange { delivery: ChangeDelivery }
export interface CatalogVersion extends CatalogChange { snapshot: CatalogModel[]; changeSummary: string }
export interface PendingExport { version: CatalogVersion; change?: CatalogChange }
export interface CatalogDoc { _id: string; provider: string; models?: CatalogModel[]; updatedAt?: Date; updatedBy?: string; source?: CatalogSource; revision?: number; commitId?: string; snapshotId?: string; scan?: CatalogScan; pendingExport?: PendingExport }
export interface ManualReplacement { provider: string; models: ModelInput[]; updatedBy: string; changeSummary?: string }
export interface CatalogIdentity { commitId?: string; revision: number; snapshotId: string }
export type ReplacementResult =
  | ({ kind: "committed"; commitId: string; recoveryPending: boolean } & CatalogIdentity & CatalogDiff)
  | ({ kind: "unchanged"; lastSucceededAt: Date } & CatalogIdentity)
  | { kind: "superseded" }
  | { kind: "not-committed"; error: SafeCatalogError; retriable: boolean }
  | { kind: "commit-unknown"; operationId: string; error: SafeCatalogError };
export type RecoveryResult = { provider: string; kind: "recovered" } | { provider: string; kind: "pending" | "error"; error: SafeCatalogError };
export type BeginResult = { kind: "started"; attempt: DiscoveryAttempt } | { kind: "busy" };
export type FailResult = { kind: "recorded" } | { kind: "superseded" };
```

- [ ] **Step 2:** Implement the pure value module. Validation always runs inside the writer, including when the SDK tool schema is bypassed. Keep `changeSummary || diffText` behavior. Complete prospective BSON validation happens after merging retained notes and embedding both immutable payloads.

```ts
// src/admin/model-catalog-value.ts
import { createHash } from "node:crypto";
import { BSON } from "mongodb";
import type { CatalogDoc, CatalogModel, CatalogSource, CatalogVersion, FailureCode, ModelInput, SafeCatalogError } from "./model-catalog-types.js";
export class CatalogError extends Error {
  constructor(readonly safe: SafeCatalogError) { super(safe.message); }
}
export function safeError(provider: string, code: FailureCode, httpStatus?: number): SafeCatalogError {
  return { code, message: `Model catalog ${provider}: ${code}${httpStatus === undefined ? "" : ` (HTTP ${httpStatus})`}.`, ...(httpStatus === undefined ? {} : { httpStatus }) };
}
export function reject(provider: string, code: FailureCode): never { throw new CatalogError(safeError(provider, code)); }
export function object(value: unknown, provider: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) reject(provider, "malformed");
  return value as Record<string, unknown>;
}
export function string(value: unknown, provider: string, id = false): string {
  if (typeof value !== "string" || !value.trim() || (id && value.trim() !== value)) reject(provider, "malformed");
  return value;
}
export function normalizedPayload(provider: string, rows: unknown, manual = false): ModelInput[] {
  if (!Array.isArray(rows)) reject(provider, "malformed");
  if (!rows.length) reject(provider, "empty");
  const seen = new Set<string>();
  const result = rows.map((row) => {
    const x = object(row, provider), id = string(x.id, provider, true), displayName = string(x.displayName, provider);
    if (seen.has(id)) throw new CatalogError({ code: "malformed", message: "Duplicate model ids in input." });
    seen.add(id);
    if (manual && x.notes !== undefined && typeof x.notes !== "string") reject(provider, "malformed");
    return { id, displayName, ...(manual && x.notes ? { notes: x.notes as string } : {}) };
  });
  if (Buffer.byteLength(JSON.stringify(result), "utf8") > 1024 * 1024) reject(provider, "too-large");
  return result;
}
export function snapshotId(provider: string, models: ModelInput[]): string {
  return createHash("sha256").update(JSON.stringify([provider, models.map((m) => [m.id, m.displayName, m.notes || null])]), "utf8").digest("hex");
}
export function diffText(added: string[], removed: string[]): string {
  const fmt = (xs: string[]) => xs.length ? ` (${xs.join(", ")})` : "";
  return `+${added.length}${fmt(added)}, -${removed.length}${fmt(removed)}`;
}
export function replacement(current: CatalogDoc | null, provider: string, input: ModelInput[], source: CatalogSource, updatedBy: string, commitId: string, now: Date, summary?: string) {
  const previous = current?.models ?? [], byId = new Map(previous.map((m) => [m.id, m]));
  const models: CatalogModel[] = input.map((m) => {
    const old = byId.get(m.id), notes = source === "discovery" ? old?.notes : m.notes;
    return { id: m.id, displayName: m.displayName, ...(notes ? { notes } : {}), addedAt: old?.addedAt ?? now };
  });
  normalizedPayload(provider, models, true);
  const ids = new Set(models.map((m) => m.id));
  const added = models.filter((m) => !byId.has(m.id)).map((m) => m.id), removed = previous.filter((m) => !ids.has(m.id)).map((m) => m.id);
  const bootstrap = previous.length === 0, hash = snapshotId(provider, models), revision = (current?.revision ?? 0) + 1;
  const common = { _id: commitId, provider, revision, snapshotId: hash, source, updatedBy, createdAt: now, bootstrap, added, removed, modelCount: models.length };
  const version: CatalogVersion = { ...common, snapshot: models, changeSummary: summary || diffText(added, removed) };
  const pendingExport = { version, ...(bootstrap || added.length || removed.length ? { change: common } : {}) };
  const fields = { provider, models, revision, commitId, snapshotId: hash, source, updatedBy, updatedAt: now, pendingExport };
  return { fields, version, unchanged: previous.length > 0 && (current?.snapshotId ?? snapshotId(provider, previous)) === hash };
}
export function checkBson(doc: CatalogDoc): void {
  if (BSON.calculateObjectSize(doc) >= 16 * 1024 * 1024) reject(doc.provider, "too-large");
}
```

- [ ] **Step 3:** Add table-driven value tests: nonempty/duplicate/padded ID/blank display/wrong notes; exact SHA-256 input including order and `notes || null`; payload at/over 1 MiB; retained/new/reintroduced timestamps; manual omitted/empty notes clear; discovery preserves latest notes; name/note/order-only differences; legacy missing hash/revision; absent/empty bootstrap; BSON envelope at/over limit including large summary/scan fields. Use generated fixture IDs, never a production default model list.
- [ ] **Step 4:** Run `npx vitest run src/admin/model-catalog-value.test.ts` and `npm run typecheck`. Expected: value cases pass; zero TypeScript errors. Commit these files with `git commit -m "feat: define shared model catalog values and contracts"` after staging only Task 1 files.

## Task 2 — Subscription-only provider discovery

**Files:** Create `src/admin/model-catalog-discovery.ts`, `.test.ts`; modify `src/agents/provider-adapters/oauth-credentials.ts` at `defaultCodexCommand`.

- [ ] **Step 1:** Change only the declaration `function defaultCodexCommand(): string` to `export function defaultCodexCommand(): string`. Use this resolver for the exact command passed to both `--version` and `createCodexOpenAITokenProvider({ refreshCommand })`; preserve optional adapter-compatible auth path/command overrides in discovery dependencies. Keep the current auth-path default and refresh single-flight helpers intact.
- [ ] **Step 2:** Create the discovery module below. The explicit environment exclusion boundary removes the entire `ANTHROPIC_`, `_CLAUDE_`, `CLAUDE_`, and `CCR_` namespaces, retaining only the supported OAuth token and `CLAUDE_CONFIG_DIR` for the service account's stored login. This includes the concrete known selectors listed after the code; no ambient backend flag can opt itself back in. SDK `Options.env` replaces the child environment; do not merge the unsanitized environment again.

```ts
// src/admin/model-catalog-discovery.ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { query, type Query } from "@anthropic-ai/claude-agent-sdk";
import { createCodexOpenAITokenProvider, defaultCodexCommand } from "../agents/provider-adapters/oauth-credentials.js";
import { resolveOAuthFileToken } from "../agents/provider-adapters/grok-oauth.js";
import { CatalogError, normalizedPayload, object, reject, safeError, string } from "./model-catalog-value.js";
import type { CatalogProvider, DiscoveredModel } from "./model-catalog-types.js";
const exec = promisify(execFile);
const lexical = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
type ControlQuery = Pick<Query, "accountInfo" | "supportedModels" | "close">;
export interface DiscoveryDependencies {
  env?: NodeJS.ProcessEnv; now?: () => number; fetch?: typeof fetch;
  query?: (args: Parameters<typeof query>[0]) => ControlQuery;
  codexAuthPath?: string; codexRefreshCommand?: string;
  codexToken?: typeof createCodexOpenAITokenProvider; grokToken?: typeof resolveOAuthFileToken;
  version?: (command: string, signal: AbortSignal, env: NodeJS.ProcessEnv) => Promise<string>;
}
export function claudeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) {
    if ((/^(?:ANTHROPIC_|_CLAUDE_|CLAUDE_|CCR_)/.test(key) && !["CLAUDE_CODE_OAUTH_TOKEN", "CLAUDE_CONFIG_DIR"].includes(key)) ||
      ["CLAUDECODE", "OPENAI_API_KEY", "XAI_API_KEY", "GROK_API_KEY"].includes(key)) delete env[key];
  }
  if (!env.CLAUDE_CODE_OAUTH_TOKEN?.trim()) delete env.CLAUDE_CODE_OAUTH_TOKEN;
  return env;
}
export function validateClaudeAccount(account: unknown, env: NodeJS.ProcessEnv): void {
  if (!account || typeof account !== "object" || Array.isArray(account)) reject("claude", "auth");
  const a = account as Record<string, unknown>, token = Boolean(env.CLAUDE_CODE_OAUTH_TOKEN?.trim());
  const labels = ["Claude Pro", "Claude Max", "Claude Team", "Claude Enterprise"];
  if (a.apiProvider !== "firstParty" || a.apiKeySource !== undefined ||
    (token ? a.tokenSource !== "CLAUDE_CODE_OAUTH_TOKEN" || a.subscriptionType !== undefined :
      typeof a.subscriptionType !== "string" || !labels.includes(a.subscriptionType) || a.tokenSource !== undefined)) reject("claude", "auth");
}
function completeContainer(raw: unknown, key: string, provider: CatalogProvider): unknown[] {
  const body = object(raw, provider);
  for (const name of ["next", "next_cursor", "nextCursor", "next_page_token", "nextPageToken", "next_token", "continuation", "continuationToken", "has_more", "hasMore"]) {
    if (body[name] !== undefined && body[name] !== null && body[name] !== false && body[name] !== "") reject(provider, "malformed");
  }
  if (body.links && object(body.links, provider).next) reject(provider, "malformed");
  if (!Array.isArray(body[key])) reject(provider, "malformed");
  return body[key];
}
export function normalizeProvider(provider: CatalogProvider, raw: unknown): DiscoveredModel[] {
  let rows: DiscoveredModel[];
  if (provider === "claude") {
    if (!Array.isArray(raw)) reject(provider, "malformed");
    const aliases = new Set<string>(), seen = new Map<string, boolean>(); rows = [];
    for (const row of raw) {
      const x = object(row, provider), value = string(x.value, provider, true);
      if (aliases.has(value)) reject(provider, "malformed"); aliases.add(value);
      if (x.resolvedModel !== undefined && typeof x.resolvedModel !== "string") reject(provider, "malformed");
      const resolved = typeof x.resolvedModel === "string" && x.resolvedModel.trim().length > 0;
      const id = resolved ? string(x.resolvedModel, provider, true) : value, displayName = string(x.displayName, provider);
      if (seen.has(id)) { if (!resolved || !seen.get(id)) reject(provider, "malformed"); continue; }
      seen.set(id, resolved); rows.push({ id, displayName });
    }
  } else if (provider === "codex") {
    const eligible = completeContainer(raw, "models", provider).flatMap((row) => {
      const x = object(row, provider);
      if (!["list", "hide", "none"].includes(x.visibility as string)) reject(provider, "malformed");
      if (x.visibility !== "list") return [];
      if (typeof x.priority !== "number" || !Number.isFinite(x.priority) || !Number.isInteger(x.priority)) reject(provider, "malformed");
      return [{ id: string(x.slug, provider, true), displayName: string(x.display_name, provider), priority: x.priority }];
    });
    rows = eligible.sort((a, b) => a.priority - b.priority || lexical(a.id, b.id)).map(({ id, displayName }) => ({ id, displayName }));
  } else {
    rows = completeContainer(raw, "data", provider).map((row) => {
      const x = object(row, provider), id = string(x.id, provider, true);
      return { id, displayName: x.name === undefined ? id : string(x.name, provider) };
    }).sort((a, b) => lexical(a.id, b.id));
  }
  return normalizedPayload(provider, rows);
}
async function readJson(response: Response, provider: CatalogProvider, signal: AbortSignal): Promise<unknown> {
  if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new CatalogError(safeError(provider, response.status === 401 || response.status === 403 ? "auth" : "http", response.status)); }
  if (!/^(application\/json|application\/[\w.+-]+\+json)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) { void response.body?.cancel().catch(() => undefined); reject(provider, "malformed"); }
  const reader = response.body?.getReader(); if (!reader) reject(provider, "malformed");
  const chunks: Uint8Array[] = []; let bytes = 0, complete = false;
  try {
    while (true) {
      signal.throwIfAborted(); const part = await reader.read(); if (part.done) break;
      bytes += part.value.byteLength; if (bytes > 4 * 1024 * 1024) reject(provider, "too-large"); chunks.push(part.value);
    }
    complete = true;
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { reject(provider, "malformed"); }
  } finally { if (!complete) void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}
export function createModelCatalogDiscovery(deps: DiscoveryDependencies = {}) {
  return async function discoverProviderModels(provider: CatalogProvider, options: { signal: AbortSignal }): Promise<DiscoveredModel[]> {
    if (!["claude", "codex", "grok"].includes(provider)) reject("provider", "malformed");
    const now = deps.now ?? Date.now, deadline = now() + 60_000, controller = new AbortController();
    let queryHandle: ControlQuery | undefined, release = () => {}, timedOut = false;
    const cancel = () => controller.abort(); options.signal.addEventListener("abort", cancel, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, 60_000);
    if (options.signal.aborted) controller.abort();
    const check = () => { if (now() >= deadline) { timedOut = true; controller.abort(); } controller.signal.throwIfAborted(); };
    let onAbort = () => {};
    const aborted = new Promise<never>((_resolve, rejectAbort) => { onAbort = () => rejectAbort(new Error("aborted")); controller.signal.addEventListener("abort", onAbort, { once: true }); if (controller.signal.aborted) onAbort(); });
    const work = async () => {
      check(); const env = deps.env ?? process.env;
      if (provider === "claude") {
        const clean = claudeEnvironment(env), released = new Promise<void>((resolve) => { release = resolve; });
        async function* input(): AsyncGenerator<never> { await released; }
        queryHandle = (deps.query ?? query)({ prompt: input(), options: { env: clean, abortController: controller, settingSources: [], tools: [], allowedTools: [], hooks: {}, plugins: [], mcpServers: {}, persistSession: false } });
        validateClaudeAccount(await queryHandle.accountInfo(), clean); check();
        const models = await queryHandle.supportedModels(); check(); return normalizeProvider(provider, models);
      }
      let token: string, url: string;
      if (provider === "codex") {
        const command = deps.codexRefreshCommand ?? defaultCodexCommand(); let output: string;
        try { output = await (deps.version ?? (async (cmd, signal, childEnv) => (await exec(cmd, ["--version"], { signal, timeout: 5_000, maxBuffer: 64 * 1024, env: childEnv })).stdout))(command, controller.signal, env); }
        catch { reject(provider, "client-version"); }
        check(); const version = output.match(/(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?)(?=\s|$)/)?.[1];
        if (!version) reject(provider, "client-version");
        try { const get = (deps.codexToken ?? createCodexOpenAITokenProvider)({ authPath: deps.codexAuthPath, refreshCommand: command, env }); if (!get) reject(provider, "auth"); token = await get(); }
        catch { reject(provider, "auth"); }
        url = `https://chatgpt.com/backend-api/codex/models?client_version=${encodeURIComponent(version)}`;
      } else {
        try { token = await (deps.grokToken ?? resolveOAuthFileToken)("~/.grok/auth.json"); } catch { reject(provider, "auth"); }
        url = "https://cli-chat-proxy.grok.com/v1/models";
      }
      check(); if (typeof token !== "string" || !token.trim()) reject(provider, "auth");
      let response: Response;
      try { response = await (deps.fetch ?? fetch)(url, { method: "GET", headers: { Authorization: `Bearer ${token}`, Accept: "application/json" }, redirect: "error", signal: controller.signal }); }
      catch { reject(provider, "http"); }
      const raw = await readJson(response, provider, controller.signal); check(); return normalizeProvider(provider, raw);
    };
    try { return await Promise.race([work(), aborted]); }
    catch (error) { if (timedOut) reject(provider, "timeout"); if (options.signal.aborted) reject(provider, "canceled"); if (error instanceof CatalogError) throw error; reject(provider, "malformed"); }
    finally { clearTimeout(timer); options.signal.removeEventListener("abort", cancel); controller.signal.removeEventListener("abort", onAbort); release(); try { queryHandle?.close(); } catch { /* Cleanup must not disclose SDK metadata. */ } }
  };
}
export const discoverProviderModels = createModelCatalogDiscovery();
```

The environment fixture must individually include and exclude `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_PROFILE`, `ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, `ANTHROPIC_CUSTOM_HEADERS`, `CLAUDE_API_KEY`, `CLAUDE_CODE_API_BASE_URL`, `_CLAUDE_CODE_ASSUME_FIRST_PARTY_BASE_URL`, `CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR`, `CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR`, `CCR_OAUTH_TOKEN_FILE`, `CLAUDE_BG_AUTH_SNAPSHOT_PATH`, `CLAUDE_BG_DISPATCHER_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_SUBSCRIPTION_TYPE`, `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_FOUNDRY`, `CLAUDE_CODE_USE_VERTEX`, `CLAUDE_CODE_USE_ANTHROPIC_AWS`, `CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD`, `CLAUDE_CODE_USE_MANTLE`, `CLAUDE_CODE_USE_GATEWAY`, `CLAUDE_CODE_GATEWAY_TOKEN_FILE_DESCRIPTOR`, `CLAUDE_CODE_HOST_AUTH_ENV_VAR`, `CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST`, `CLAUDE_CODE_CUSTOM_OAUTH_URL`, and `CLAUDECODE`. Also exercise an unknown future `CLAUDE_CODE_USE_*` selector. Preserve `HOME`, `PATH`, normal locale/runtime environment, `CLAUDE_CONFIG_DIR`, and a nonblank configured `CLAUDE_CODE_OAUTH_TOKEN`; blank OAuth env is removed, never used as evidence.

- [ ] **Step 3:** Use the real initialization mapping in the fixture helper below. Source basis: installed CLI `nQ` emits `subscription` **else** `tokenSource`; `Pf`/`iQe` maps subscription to `subscriptionType`; SDK `accountInfo()` returns `initialization.account` unchanged. Record SDK/CLI versions in the fixture comment, not brittle binary offsets in production code.

```ts
// In src/admin/model-catalog-discovery.test.ts
const initializationAccount = (internal: Record<string, unknown>, apiProvider = "firstParty") => ({
  email: internal.email, organization: internal.organization,
  subscriptionType: internal.subscription, tokenSource: internal.tokenSource,
  apiKeySource: internal.apiKeySource, apiProvider,
});
const acceptedAccounts = [
  ...["Claude Pro", "Claude Max", "Claude Team", "Claude Enterprise"].map((subscription) => ({ env: {}, account: initializationAccount({ subscription }) })),
  { env: { CLAUDE_CODE_OAUTH_TOKEN: "test-secret" }, account: initializationAccount({ tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }) },
];
```

- [ ] **Step 4:** Add these mandatory provider cases. For every Claude outcome, obtain `args.prompt[Symbol.asyncIterator]().next()` in the fake, verify it never resolves to `done:false`, and after cleanup expect `done:true`; assert `close()` exactly once when query construction returned a handle. If construction throws, the input still releases. Do not iterate the query itself or yield a user message.

| Provider group | Fixtures and assertions |
| --- | --- |
| Claude auth | Each accepted account above; reject raw labels `pro/max/team/enterprise`, `Claude API`, firstParty alone, both fields, unknown source, each unsupported source from spec, null/blank/wrong-type evidence, non-first-party, API-key evidence including blank/null, configured-token/stored-shape mismatch, token-source/no-configured-token mismatch. Auth failures must not call `supportedModels`. |
| Claude lifecycle | Success, `accountInfo` reject, `supportedModels` reject, query construction throw, malformed rows, auth reject, 60-second timeout, external cancellation, already-aborted signal. Close/release all obtained resources; no late acceptance after cancellation. |
| Claude models | Canonical `resolvedModel`, unresolved `value`, SDK order, distinct aliases collapse first name, repeated unresolved ID invalid, duplicate alias invalid, mixed resolved/unresolved collision invalid, wrong fields and empty result. Ignore descriptions/capabilities. |
| Codex | Exact host/path/version/Authorization; configured command and auth path forwarded; bundled/PATH resolver unchanged; missing/unparseable CLI version fails; 5-second version bound; `list/hide/none`; missing/unknown visibility invalid; included row integer priority required; stable lexical tie-break; retain `supported_in_api:false`; hidden rows need no slug/priority; duplicates and no eligible models fail. |
| Grok | Exact CLI proxy endpoint, exact `~/.grok/auth.json` helper argument, optional valid name/id fallback, lexical ordering, helper error sanitized. No `api.x.ai` catalog call. Late shared refresh may finish after abort but never issues a model-list fetch. |
| HTTP/all | Non-JSON content type, parse failure, truncated/stream failure, 401/403/500, redirect error, continuation markers, >4 MiB chunked response, >1 MiB normalized payload, empty/malformed container/row. Request signal aborts on timeout/cancellation. Never contact public/API-key fallback. All raw secrets/error bodies/version output/SDK metadata absent from surfaced failure. |

- [ ] **Step 5:** Run `npx vitest run src/admin/model-catalog-discovery.test.ts src/agents/provider-adapters/grok-oauth.test.ts` and `npm run typecheck`. Expected: all pass without spawning Claude/Codex or using real credentials. Commit only Task 2 files with `git commit -m "feat: discover subscription models without generation"`.

## Task 3 — Idempotent export and recoverable immutable records

**Files:** Create `src/admin/model-catalog-export.ts`; tests live in Task 4's store suites.

- [ ] **Step 1:** Add the export module. `isDeepStrictEqual` compares BSON-decoded payloads including dates; only `delivery` is excluded for outbox comparison. Never update an existing outbox row, including its retry/recipient/claim fields later introduced by KPR-461.

```ts
// src/admin/model-catalog-export.ts
import { isDeepStrictEqual } from "node:util";
import type { Collection, Db } from "mongodb";
import type { CatalogChangeDoc, CatalogDoc, CatalogVersion, RecoveryResult } from "./model-catalog-types.js";
import { CatalogError, safeError } from "./model-catalog-value.js";
export const JOURNALED = { writeConcern: { w: 1, j: true } } as const;
export const isDuplicate = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && error.code === 11000);
export function catalogCollections(db: Db) {
  return { catalogs: db.collection<CatalogDoc>("agent_model_catalog", JOURNALED), versions: db.collection<CatalogVersion>("agent_model_catalog_versions", JOURNALED), changes: db.collection<CatalogChangeDoc>("agent_model_catalog_changes", JOURNALED) };
}
export type CatalogCollections = ReturnType<typeof catalogCollections>;
async function insertImmutable<T extends { _id: string }>(collection: Collection<T>, payload: T, immutable: (row: T) => unknown): Promise<void> {
  try { await collection.insertOne(payload as never, JOURNALED); }
  catch (error) {
    if (!isDuplicate(error)) throw error;
    const found = await collection.findOne({ _id: payload._id } as never);
    if (!found || !isDeepStrictEqual(immutable(found as T), immutable(payload))) throw new CatalogError({ code: "storage", message: "Model catalog immutable export mismatch; recovery remains pending." });
  }
}
export async function recoverProvider(collections: CatalogCollections, provider: string): Promise<RecoveryResult> {
  let hasEnvelope = false;
  try {
    const doc = await collections.catalogs.findOne({ _id: provider }), envelope = doc?.pendingExport;
    if (!envelope) return { provider, kind: "recovered" }; hasEnvelope = true;
    await insertImmutable(collections.versions, envelope.version, (row) => row);
    if (envelope.change) {
      const change: CatalogChangeDoc = { ...envelope.change, delivery: { state: "pending", attempts: 0, nextAttemptAt: envelope.change.createdAt } };
      await insertImmutable(collections.changes, change, ({ delivery: _delivery, ...immutable }) => immutable);
    }
    await collections.catalogs.updateOne({ _id: provider, "pendingExport.version._id": envelope.version._id }, { $unset: { pendingExport: "" } }, JOURNALED);
    const after = await collections.catalogs.findOne({ _id: provider });
    return after?.pendingExport ? { provider, kind: "pending", error: safeError(provider, "storage") } : { provider, kind: "recovered" };
  } catch (error) { return { provider, kind: hasEnvelope ? "pending" : "error", error: error instanceof CatalogError ? error.safe : safeError(provider, "storage") }; }
}
```

- [ ] **Step 2:** Add store tests alongside Task 4 before committing: insert failure/duplicate mismatch for history/change; ambiguous insert acknowledgment followed by duplicate verification; failed/ambiguous slot clear; competing recoveries; no-change export; delivery fields modified between retries remain unchanged. New history uses string UUID `_id`; legacy ObjectId rows remain untouched. Add exact `(provider:1, createdAt:-1)` history and `(delivery.state:1, delivery.nextAttemptAt:1)` outbox indexes in the store below; no TTL. Collection handles inherit `JOURNALED`; driver 7.6 `CreateIndexesOptions` intentionally omits per-call `writeConcern`, so do not pass `JOURNALED` to `createIndex`.
- [ ] **Step 3:** Verify after Task 4 adds tests with `npx vitest run src/admin/model-catalog-store.test.ts`. Expected: every export-boundary case passes with one immutable row per committed ID. Commit Task 3/4 together after verification if no independently runnable tests exist yet.

## Task 4 — Store CAS, attempt fences, and uncertainty

**Files:** Create `src/admin/model-catalog-store.ts`, `src/admin/model-catalog-store.test.ts`, `src/admin/testing/catalog-db.test-support.ts`.

- [ ] **Step 1:** Create the store using the injected guarded `Db`. No production change to `src/index.ts` is necessary: `index.ts:156` already injects `guardDb(rawDb, writeGuard)` through manager/runner to `buildAdminTools`. Later the scanner constructs the same store with that `Db`; all instances share the database protocol, not a process mutex.

```ts
// src/admin/model-catalog-store.ts
import { randomUUID } from "node:crypto";
import type { Db, Filter, UpdateFilter } from "mongodb";
import { BUILTIN_CATALOG_PROVIDERS } from "./model-catalog-types.js";
import type { BeginResult, CatalogDoc, CatalogIdentity, CatalogProvider, CatalogVersion, DiscoveryAttempt, FailResult, ManualReplacement, ModelInput, RecoveryResult, ReplacementResult, SafeCatalogError } from "./model-catalog-types.js";
import { CatalogError, checkBson, normalizedPayload, reject, replacement, safeError, snapshotId, string } from "./model-catalog-value.js";
import { catalogCollections, isDuplicate, JOURNALED, recoverProvider } from "./model-catalog-export.js";
const tokenPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const validDate = (date: Date) => date instanceof Date && Number.isFinite(date.getTime());
const revisionFilter = (doc: CatalogDoc): Filter<CatalogDoc> => doc.revision === undefined ? { revision: { $exists: false } } : { revision: doc.revision };
const runningFilter = (attempt: DiscoveryAttempt, now: Date): Filter<CatalogDoc> => ({ "scan.attemptId": attempt.attemptId, "scan.outcome": "running", "scan.leaseExpiresAt": { $gt: now }, $expr: { $gt: ["$scan.leaseExpiresAt", "$$NOW"] } });
const successUpdate = (now: Date): UpdateFilter<CatalogDoc> => ({ $set: { "scan.outcome": "succeeded", "scan.finishedAt": now, "scan.lastSucceededAt": now }, $unset: { "scan.error": "", "scan.leaseExpiresAt": "" } });
export class ModelCatalogStore {
  readonly collections; private indexInit?: Promise<void>;
  // At most one local proof per built-in provider; absence never proves noncommit.
  private readonly freshAttempts = new Map<CatalogProvider, { attemptId: string; ready: boolean }>();
  constructor(db: Db, private readonly options: { listPluginProviderIds?: () => string[]; now?: () => Date; uuid?: () => string } = {}) { this.collections = catalogCollections(db); }
  private now(): Date { return this.options.now?.() ?? new Date(); }
  async ensureIndexes(): Promise<void> {
    if (!this.indexInit) this.indexInit = Promise.all([
      this.collections.versions.createIndex({ provider: 1, createdAt: -1 }),
      this.collections.changes.createIndex({ "delivery.state": 1, "delivery.nextAttemptAt": 1 }),
    ]).then(() => undefined).catch((error) => { this.indexInit = undefined; throw error; });
    return this.indexInit;
  }
  async readCatalogState(provider: string) {
    try { const snapshot = await this.collections.catalogs.findOne({ _id: provider }); return { snapshot, scan: snapshot?.scan, recoveryPending: Boolean(snapshot?.pendingExport) }; }
    catch { throw new CatalogError(safeError(provider, "storage")); }
  }
  async pendingChanges(now = this.now(), limit = 100) {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1000) reject("changes", "malformed");
    try { return await this.collections.changes.find({ "delivery.state": "pending", "delivery.nextAttemptAt": { $lte: now } }).sort({ "delivery.nextAttemptAt": 1, _id: 1 }).limit(limit).toArray(); }
    catch { throw new CatalogError(safeError("changes", "storage")); }
  }
  async recoverPendingExports(provider?: string): Promise<RecoveryResult[]> {
    if (provider !== undefined) return [await recoverProvider(this.collections, provider)];
    let providers: string[];
    try { providers = (await this.collections.catalogs.find({ pendingExport: { $exists: true } }, { projection: { _id: 1 } }).toArray()).map((doc) => doc._id); }
    catch { return [{ provider: "*", kind: "error", error: safeError("all", "storage") }]; }
    const results: RecoveryResult[] = []; for (const id of providers) results.push(await recoverProvider(this.collections, id)); return results;
  }
  private knownFailure(provider: string, error: unknown, retriable = false): ReplacementResult {
    return { kind: "not-committed", error: error instanceof CatalogError ? error.safe : safeError(provider, "storage"), retriable };
  }
  private async committed(version: CatalogVersion): Promise<ReplacementResult> {
    const recovered = await recoverProvider(this.collections, version.provider);
    return { kind: "committed", commitId: version._id, revision: version.revision, snapshotId: version.snapshotId, bootstrap: version.bootstrap, added: version.added, removed: version.removed, recoveryPending: recovered.kind !== "recovered" };
  }
  private async reconcile(provider: string, operationId: string, attempt?: DiscoveryAttempt, validatedIdentity?: CatalogIdentity): Promise<ReplacementResult> {
    for (let check = 0; check < 2; check++) {
      try {
        // Read catalog FIRST, history SECOND: a later writer must project before replacing the catalog evidence.
        const doc = await this.collections.catalogs.findOne({ _id: provider });
        if (doc?.pendingExport?.version._id === operationId) return this.committed(doc.pendingExport.version);
        const version = await this.collections.versions.findOne({ _id: operationId });
        if (version) return this.committed(version);
        if (attempt && validatedIdentity && doc?.scan?.attemptId === operationId && doc.scan.outcome === "succeeded" && doc.scan.lastSucceededAt) {
          return { kind: "unchanged", ...validatedIdentity, lastSucceededAt: doc.scan.lastSucceededAt };
        }
      } catch { /* A read failure cannot settle a mutation's outcome. */ }
      // One bounded recovery/recheck observes a late commit at this boundary.
      // Negative evidence and every recovery failure still leave it unknown.
      if (check === 0) await recoverProvider(this.collections, provider);
    }
    return { kind: "commit-unknown", operationId, error: safeError(provider, "storage") };
  }
  async replaceManual(input: ManualReplacement): Promise<ReplacementResult> {
    let rows: ModelInput[];
    try {
      const provider = string(input.provider, "provider", true);
      if (provider === "gemini") throw new CatalogError({ code: "malformed", message: "Gemini is always resolved live and cannot be refreshed." });
      const valid: string[] = [...BUILTIN_CATALOG_PROVIDERS, ...(this.options.listPluginProviderIds?.() ?? [])];
      if (!valid.includes(provider)) throw new CatalogError({ code: "malformed", message: `Unknown provider '${provider}'. Valid: ${valid.join(", ")}.` });
      string(input.updatedBy, provider); if (input.changeSummary !== undefined && typeof input.changeSummary !== "string") reject(provider, "malformed");
      rows = normalizedPayload(provider, input.models, true);
    } catch (error) { return this.knownFailure("manual", error); }
    return this.write(input.provider, rows, input.updatedBy, this.options.uuid?.() ?? randomUUID(), input.changeSummary);
  }
  async applyDiscovery(attempt: DiscoveryAttempt, input: unknown): Promise<ReplacementResult> {
    // Invalid operation identities could never have reached this writer. Other
    // validation/refusal is definitive only while we own a never-submitted token.
    if (!BUILTIN_CATALOG_PROVIDERS.includes(attempt.provider) || !tokenPattern.test(attempt.attemptId)) return this.knownFailure("discovery", new CatalogError(safeError("attempt", "malformed")));
    const proof = this.freshAttempts.get(attempt.provider);
    if (!proof || proof.attemptId !== attempt.attemptId || !proof.ready) return this.reconcile(attempt.provider, attempt.attemptId, attempt);
    // Consume before any await: parallel calls with this UUID can only reconcile.
    proof.ready = false;
    let rows: ModelInput[];
    try { this.validateAttempt(attempt); rows = normalizedPayload(attempt.provider, input); }
    catch (error) { if (this.freshAttempts.get(attempt.provider) === proof) proof.ready = true; return this.knownFailure("discovery", error); }
    const result = await this.write(attempt.provider, rows, "system:model-catalog-scanner", attempt.attemptId, undefined, attempt);
    // The write loop returns not-committed only if every mutation was refused
    // before submission or acknowledged as unmatched. Unknown never restores it.
    if (result.kind === "not-committed" && this.freshAttempts.get(attempt.provider) === proof) proof.ready = true;
    return result;
  }
  private validateAttempt(attempt: DiscoveryAttempt): void {
    if (!BUILTIN_CATALOG_PROVIDERS.includes(attempt.provider) || !tokenPattern.test(attempt.attemptId) || !validDate(attempt.startedAt) || !validDate(attempt.leaseExpiresAt) || attempt.leaseExpiresAt <= attempt.startedAt) reject("attempt", "malformed");
  }
  private async write(provider: string, rows: ModelInput[], actor: string, operationId: string, summary?: string, attempt?: DiscoveryAttempt): Promise<ReplacementResult> {
    // Discovery enters only with the consumed local proof: no older invocation
    // with this UUID may be outstanding. Unproven/restarted calls never enter.
    for (let tries = 0; tries < 8; tries++) {
      let current: CatalogDoc | null;
      try {
        // Existing-operation evidence precedes any fallible recovery/index writes.
        current = await this.collections.catalogs.findOne({ _id: provider });
        if (attempt) {
          if (current?.pendingExport?.version._id === operationId) return this.committed(current.pendingExport.version);
          const prior = await this.collections.versions.findOne({ _id: operationId }); if (prior) return this.committed(prior);
          if (current?.scan?.attemptId === operationId && current.scan.outcome === "succeeded") return this.reconcile(provider, operationId, attempt);
        }
        await this.ensureIndexes();
        const recovered = await recoverProvider(this.collections, provider);
        if (recovered.kind !== "recovered") {
          // Only the local never-submitted proof licenses refusal here;
          // unresolved/restarted UUIDs are handled entirely by reconcile().
          if (attempt) { const result = await this.reconcile(provider, operationId, attempt); if (result.kind === "committed") return result; }
          return this.knownFailure(provider, new CatalogError(recovered.error), true);
        }
        current = await this.collections.catalogs.findOne({ _id: provider });
        if (attempt) {
          const prior = await this.collections.versions.findOne({ _id: operationId }); if (prior) return this.committed(prior);
          if (current?.scan?.attemptId === operationId && current.scan.outcome === "succeeded") return this.reconcile(provider, operationId, attempt);
        }
      } catch (error) { return this.knownFailure(provider, error, true); }
      const now = this.now();
      if (attempt && (!current || current.scan?.attemptId !== attempt.attemptId || current.scan.outcome !== "running" || !current.scan.leaseExpiresAt || current.scan.leaseExpiresAt <= now)) return { kind: "superseded" };
      let next: ReturnType<typeof replacement>;
      try { next = replacement(current, provider, rows, attempt ? "discovery" : "manual", actor, operationId, now, summary); }
      catch (error) { return this.knownFailure(provider, error); }
      const filter: Filter<CatalogDoc> = { _id: provider, ...(current ? revisionFilter(current) : {}), pendingExport: { $exists: false }, ...(attempt ? runningFilter(attempt, now) : {}) };
      const success = attempt ? successUpdate(now) : {};
      if (attempt && next.unchanged && current) {
        try {
          const changed = await this.collections.catalogs.updateOne(filter, success, JOURNALED);
          if (!changed.matchedCount) continue;
          return { kind: "unchanged", commitId: current.commitId, revision: current.revision ?? 0, snapshotId: current.snapshotId ?? snapshotId(provider, current.models ?? []), lastSucceededAt: now };
        } catch (error) {
          // With the local proof, this guard refusal excludes every submission.
          if (error && typeof error === "object" && "code" in error && error.code === "DB_IDENTITY_MISMATCH") return this.knownFailure(provider, error, true);
          return this.reconcile(provider, operationId, attempt, { commitId: current.commitId, revision: current.revision ?? 0, snapshotId: current.snapshotId ?? snapshotId(provider, current.models ?? []) });
        }
      }
      try {
        const prospective: CatalogDoc = { ...(current ?? { _id: provider }), ...next.fields };
        if (attempt && current?.scan) prospective.scan = { ...current.scan, outcome: "succeeded", finishedAt: now, lastSucceededAt: now };
        if (prospective.scan && attempt) { delete prospective.scan.error; delete prospective.scan.leaseExpiresAt; }
        checkBson(prospective);
      } catch (error) { return this.knownFailure(provider, error); }
      try {
        if (!current) await this.collections.catalogs.insertOne({ _id: provider, ...next.fields }, JOURNALED);
        else {
          const changed = await this.collections.catalogs.updateOne(filter, { $set: { ...next.fields, ...success.$set }, ...(success.$unset ? { $unset: success.$unset } : {}) }, JOURNALED);
          if (!changed.matchedCount) continue;
        }
      } catch (error) {
        if (!current && isDuplicate(error)) continue;
        // The local proof makes this guard refusal definitive; reentry cannot reach it.
        if (error && typeof error === "object" && "code" in error && error.code === "DB_IDENTITY_MISMATCH") return this.knownFailure(provider, error, true);
        return this.reconcile(provider, operationId, attempt);
      }
      return this.committed(next.version);
    }
    // All CAS attempts were acknowledged misses; no older same-UUID write exists here.
    return this.knownFailure(provider, new CatalogError(safeError(provider, "storage")), true);
  }
  async beginDiscoveryAttempt(provider: CatalogProvider, input: Omit<DiscoveryAttempt, "provider">): Promise<BeginResult> {
    const attempt = { provider, ...input }; this.validateAttempt(attempt);
    if (attempt.leaseExpiresAt <= this.now()) reject(provider, "malformed");
    const previousProof = this.freshAttempts.get(provider);
    const acknowledgedStart = (): BeginResult => {
      // A delayed older claim acknowledgment cannot replace a successor's proof.
      if (this.freshAttempts.get(provider) === previousProof) this.freshAttempts.set(provider, { attemptId: attempt.attemptId, ready: true });
      return { kind: "started", attempt };
    };
    try {
      await this.ensureIndexes();
      for (let tries = 0; tries < 8; tries++) {
        const current = await this.collections.catalogs.findOne({ _id: provider }), now = this.now();
        if (current?.scan?.attemptId === input.attemptId) return current.scan.outcome === "running" && current.scan.leaseExpiresAt && current.scan.leaseExpiresAt > now ? { kind: "started", attempt } : { kind: "busy" };
        const scan = { attemptId: input.attemptId, startedAt: input.startedAt, leaseExpiresAt: input.leaseExpiresAt, outcome: "running" as const };
        try {
          if (!current) { await this.collections.catalogs.insertOne({ _id: provider, provider, scan }, JOURNALED); return acknowledgedStart(); }
          const acquired = await this.collections.catalogs.updateOne({ _id: provider, $or: [{ "scan.leaseExpiresAt": { $exists: false } }, { "scan.leaseExpiresAt": { $lte: now }, $expr: { $lte: ["$scan.leaseExpiresAt", "$$NOW"] } }] }, { $set: { "scan.attemptId": scan.attemptId, "scan.startedAt": scan.startedAt, "scan.leaseExpiresAt": scan.leaseExpiresAt, "scan.outcome": scan.outcome }, $unset: { "scan.finishedAt": "", "scan.error": "" } }, JOURNALED);
          if (!acquired.matchedCount) return { kind: "busy" };
          return acknowledgedStart();
        } catch (error) {
          if (!current && isDuplicate(error)) continue;
          const after = await this.collections.catalogs.findOne({ _id: provider });
          if (after?.scan?.attemptId === input.attemptId && after.scan.outcome === "running" && after.scan.leaseExpiresAt && after.scan.leaseExpiresAt > this.now()) return { kind: "started", attempt };
          throw error;
        }
      }
    } catch { throw new CatalogError(safeError(provider, "storage")); }
    return { kind: "busy" };
  }
  async failDiscoveryAttempt(attempt: DiscoveryAttempt, error: SafeCatalogError, finishedAt: Date): Promise<FailResult> {
    this.validateAttempt(attempt); if (!validDate(finishedAt)) reject(attempt.provider, "malformed");
    const allowed = ["auth", "client-version", "http", "timeout", "canceled", "malformed", "empty", "too-large", "storage"];
    if (!allowed.includes(error.code)) reject(attempt.provider, "malformed");
    const status = Number.isInteger(error.httpStatus) && error.httpStatus! >= 100 && error.httpStatus! <= 599 ? error.httpStatus : undefined;
    const safe = safeError(attempt.provider, error.code, status);
    try {
      const result = await this.collections.catalogs.updateOne({ _id: attempt.provider, ...runningFilter(attempt, this.now()) }, { $set: { "scan.outcome": "failed", "scan.finishedAt": finishedAt, "scan.error": safe }, $unset: { "scan.leaseExpiresAt": "" } }, JOURNALED);
      return { kind: result.matchedCount ? "recorded" : "superseded" };
    } catch {
      try { const doc = await this.collections.catalogs.findOne({ _id: attempt.provider }); if (doc?.scan?.attemptId === attempt.attemptId && doc.scan.outcome === "failed") return { kind: "recorded" }; } catch { /* Preserve uncertainty as a storage exception. */ }
      throw new CatalogError(safeError(attempt.provider, "storage"));
    }
  }
}
```

**Uncertainty rules that must survive implementation:** never continue the CAS retry loop after a thrown mutation except an acknowledged first-insert duplicate-key race. `reconcile` accepts positive evidence only; its two bounded evidence passes surround at most one provider-recovery pass. A negative/unavailable read or failed recovery returns `commit-unknown` with the same UUID unless a later pass finds positive evidence. Never discard that unknown result to return `not-committed`/`superseded`, issue another replacement, call `failDiscoveryAttempt`, or allocate another ID automatically. Catalog-first/history-second reconciliation prevents the read-order hole where projection races evidence lookup. Matching evidence returns `committed` even when export remains pending; rechecking after recovery also catches a commit that arrived during recovery. An unchanged acknowledgment reconciles to the identity captured before its attempted CAS, never a later manual replacement's identity; without that captured identity, conservatively retain unknown. A later attempt cannot accept the old completion. Server-side `$$NOW` rejects a completion that sat in transit until lease expiry.

The only discovery path into the write loop holds a local **never-submitted proof**. A definitively acknowledged new claim installs one entry per built-in provider (maximum three); rereading an existing token or reconciling an ambiguous begin never creates one. `applyDiscovery` consumes that entry synchronously before its first await, so parallel calls, calls after an uncertain result, and calls through a fresh store are reconciliation-only. This includes validation on a valid existing operation identity: malformed new rows/dates cannot disprove an older write. Such calls never enter index initialization, replacement/unchanged submission, guard-refusal handling, or conflict exhaustion. Negative reconciliation never replenishes proof. Only a proven `not-committed` first submission restores the same entry, and only if the map still references that exact object; a late old call cannot overwrite a successor token's eligibility. New-claim acknowledgments also install proof only if the local entry is still the one observed when beginning that call; an old delayed acknowledgment cannot displace a newer claim. Manual invocations allocate fresh UUIDs and keep their existing refusal semantics. The map is bounded local knowledge, not a lock or durable ledger; persisted revision/token/lease filters remain authoritative.

For a proven fresh invocation, validation, recovery/index/read failure, an identity-guard refusal before delegation, or eight acknowledged CAS misses may return `not-committed` and permit retry with the same token. Those refusals establish nothing about any UUID without the local proof. Unknown reentry bypasses these paths entirely, even if a guard is now engaged or a fault would force every new CAS to miss. An independently new manual replacement remains blocked by an older unexported envelope. `begin`/failure-recording storage exceptions likewise do not establish that a delayed mutation cannot finish; the caller keeps the same attempt identity and does not start external discovery until `started` is confirmed. A restarted store reconciles/recovers existing tokens; KPR-460 safely supersedes unresolved attempts through the existing lease rules before a fresh submission.

- [ ] **Step 2:** Build the fake helper with these exact operations. Expose `collection(name)`, `rows(name)`, and `before/after` hooks on method calls. Use `structuredClone` for snapshots; evaluate filter and mutate synchronously after any `before` hook completes. Required match operators: plain equality, dotted keys, `$exists`, `$gt`, `$lte`, `$or`, and the two explicit `$expr` date comparisons against `$$NOW`; reject every unsupported operator. Required updates: dotted `$set`, `$unset`; reject unsupported operators. `insertOne` throws `{ code:11000 }` on an existing `_id`, and successful updates return `{ acknowledged:true, matchedCount, modifiedCount }`. `find` supports filter/projection, sort, limit, toArray; `createIndex` records options. The following complete primitives prevent the old mock's unconditional-write behavior:

```ts
// Core of src/admin/testing/catalog-db.test-support.ts
import { isDeepStrictEqual } from "node:util";
export type Row = Record<string, any>;
export const getPath = (row: Row, path: string): any => path.split(".").reduce((value, key) => value?.[key], row);
export function matches(row: Row, filter: Row, serverNow = new Date()): boolean {
  return Object.entries(filter).every(([key, value]) => {
    if (key === "$or") return value.some((leg: Row) => matches(row, leg, serverNow));
    if (key === "$expr") {
      const entries = Object.entries(value); if (entries.length !== 1) throw new Error("Unsupported test expression");
      const [op, operands] = entries[0] as [string, string[]];
      const resolve = (item: string) => item === "$$NOW" ? serverNow : getPath(row, item.slice(1));
      if (op === "$gt") return resolve(operands[0]) > resolve(operands[1]);
      if (op === "$lte") return resolve(operands[0]) <= resolve(operands[1]);
      throw new Error(`Unsupported test expression ${op}`);
    }
    if (key.startsWith("$")) throw new Error(`Unsupported test filter ${key}`);
    const actual = getPath(row, key);
    if (value && typeof value === "object" && !(value instanceof Date) && Object.keys(value).some((op) => op.startsWith("$"))) return Object.entries(value).every(([op, expected]) => {
      if (op === "$exists") return (actual !== undefined) === expected;
      if (op === "$gt") return actual > (expected as any);
      if (op === "$lte") return actual <= (expected as any);
      throw new Error(`Unsupported test operator ${op}`);
    });
    return isDeepStrictEqual(actual, value);
  });
}
export function applyUpdate(row: Row, update: Row): void {
  for (const [op, fields] of Object.entries(update)) {
    if (op !== "$set" && op !== "$unset") throw new Error(`Unsupported test update ${op}`);
    for (const [path, value] of Object.entries(fields)) {
      const parts = path.split("."), last = parts.pop()!; let target = row;
      for (const key of parts) { if (!target[key]) target[key] = {}; target = target[key]; }
      if (op === "$set") target[last] = structuredClone(value); else delete target[last];
    }
  }
}
export function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((yes) => { resolve = yes; }); return { promise, resolve }; }
```

- [ ] **Step 3:** Complete the fake helper by appending these implementations. `faultDb` wraps either this fake or a real guarded `Db`; faults may delay real delegation or throw after actual application. Preserve method `this` binding and forward the collection options unchanged, so wrapped real collections retain inherited `JOURNALED` write concern for index creation as well as mutations.

```ts
// Append to src/admin/testing/catalog-db.test-support.ts
import type { CollectionOptions, Db } from "mongodb";
export function createCatalogFake(serverNow: () => Date = () => new Date()) {
  const tables = new Map<string, Map<string, Row>>(), indexes: Row[] = [];
  const rows = (name: string) => { if (!tables.has(name)) tables.set(name, new Map()); return tables.get(name)!; };
  const db = { collection(name: string) {
    const table = rows(name);
    return {
      async findOne(filter: Row) { const found = [...table.values()].find((row) => matches(row, filter, serverNow())); return found ? structuredClone(found) : null; },
      async insertOne(input: Row) { if (table.has(input._id)) throw Object.assign(new Error("duplicate"), { code: 11000 }); table.set(input._id, structuredClone(input)); return { acknowledged: true, insertedId: input._id }; },
      async updateOne(filter: Row, update: Row) { const row = [...table.values()].find((item) => matches(item, filter, serverNow())); if (!row) return { acknowledged: true, matchedCount: 0, modifiedCount: 0 }; const before = structuredClone(row); applyUpdate(row, update); return { acknowledged: true, matchedCount: 1, modifiedCount: Number(!isDeepStrictEqual(before, row)) }; },
      async createIndex(keys: Row, options: Row) { indexes.push({ name, keys, options }); return "test-index"; },
      find(filter: Row = {}, options: Row = {}) {
        let order: Row = {}, maximum = Infinity;
        const cursor = {
          sort(value: Row) { order = value; return cursor; }, limit(value: number) { maximum = value; return cursor; },
          async toArray() {
            const result = [...table.values()].filter((row) => matches(row, filter, serverNow())).sort((a, b) => { for (const [key, direction] of Object.entries(order)) { const x = getPath(a, key), y = getPath(b, key); if (x < y) return -direction; if (x > y) return direction; } return 0; }).slice(0, maximum);
            return result.map((row) => structuredClone(options.projection ? Object.fromEntries(Object.keys(options.projection).filter((key) => options.projection[key]).map((key) => [key, row[key]])) : row));
          },
        }; return cursor;
      },
    };
  } } as unknown as Db;
  return { db, rows, indexes };
}
export function faultDb(db: Db, intercept: (collection: string, method: string, args: any[], run: () => Promise<any>) => Promise<any>): Db {
  return new Proxy(db, { get(target, key) {
    if (key === "collection") return (name: string, options?: CollectionOptions) => {
      const collection = target.collection(name, options);
      return new Proxy(collection, { get(col, method) {
        const value = Reflect.get(col, method, col);
        if (typeof value !== "function") return value;
        if (["findOne", "insertOne", "updateOne", "createIndex"].includes(String(method))) return (...args: any[]) => intercept(name, String(method), args, () => value.apply(col, args));
        return value.bind(col);
      } });
    };
    const value = Reflect.get(target, key, target); return typeof value === "function" ? value.bind(target) : value;
  } });
}
```

- [ ] **Step 4:** Implement unit tests from this schedule table, using two store objects on the same fake. Every test asserts final catalog revision/models/scan, exact history payload/count, and outbox payload/count/delivery state. Advance an injected clock explicitly.

| Schedule | Required invariant |
| --- | --- |
| Manual seed → identical manual → notes/name/order-only → ID change | Each manual accepted write audits; only seed/ID differences create independently pending changes; summary fallback/actor/order/timestamps remain correct. |
| A and B read same revision, A commits, B CAS misses then retries | B revision/diff/retained `addedAt` derive from A. Eight conflicts yield retriable `not-committed`, no unconditional write. |
| Discovery waits; manual changes membership/names/notes; discovery finishes | Discovery controls new membership/order/names; retained notes come from latest manual winner; manual never changes scan. |
| Unchanged discovery pauses before update; manual replaces snapshot | Old revision status update matches zero; recompute and commit discovery result against new manual snapshot. |
| Two begins; expired takeover; old success/failure arrive | One active claim; late/expired results superseded; new token/snapshot/freshness survive. Begin preserves previous success and all catalog metadata. |
| Legacy nonempty missing revision/hash; status-only or empty doc | No false bootstrap for legacy; revision starts at 1 on history-bearing write; unchanged legacy discovery writes scan only; empty seeds exactly once. |
| Before snapshot commit throws definite guard refusal | No snapshot/history/change; safe retriable `not-committed`. |
| Seed catalog → warm indexes → begin a running attempt → engage `WriteGuard` immediately before the unchanged `scan.outcome:succeeded` update is delegated | `applyDiscovery` returns safe storage `not-committed` with `retriable:true`; no `commit-unknown`. The underlying update is never called, `refusedWriteCount` increases once, and the complete catalog/scan (including prior freshness), history, and outbox equal their pre-call snapshots. Test through `faultDb(guardDb(rawDb, guard), intercept)` so the fault engages the real guard before `run()`. |
| Mutation applies, throws; read sees envelope/history | One committed operation recovered; never duplicate audit. |
| Discovery replacement D: defer its update carrying `pendingExport.version._id === attemptId`, throw, observe negative reconciliation and `commit-unknown`; execute the delayed update, then fail history insertion for D and re-enter `applyDiscovery` with the same attempt UUID/rows | Return `committed` with D's exact commit/revision/snapshot/diff and `recoveryPending:true`, using the envelope before the failing export. No second replacement submission, UUID, revision, or audit/change record. The saved snapshot/scan/envelope remain exact. Repeat using a fresh store whose index creation would throw to prove evidence precedes index writes. An independent next manual replacement remains retriable `not-committed` until D exports. |
| Repeat D, but release the delayed update after re-entry's history lookup has returned null and before provider recovery reads the envelope; history insertion for D still fails | Recheck catalog-first/history-second evidence after recovery failure; the bounded recovery/recheck returns D as `committed/recoveryPending:true`, never `not-committed`. Release the barrier only once and assert one replacement submission. |
| D remains deferred after its first `commit-unknown`; on reentry the provider recovery read fails, both evidence passes are negative; then execute D | Reentry remains `commit-unknown` with D's UUID, never `not-committed`. D still returns `matchedCount:1` and commits once. Test through the original store and a fresh store; then clear faults, reconcile/recover D exactly once. |
| D is unresolved; construct a fresh store whose `createIndex` hook would release D and throw, then reenter; also repeat with D already committed before reentry | Reentry performs zero index calls: the obsolete failure boundary is unreachable. While D is pending, return D's `commit-unknown`; release it afterward and assert `matchedCount:1`. Once D has committed, return its exact `committed` identity without index initialization. Also explicitly start a failing `ensureIndexes()` on that fresh store, release D inside its fault, and reenter after the rejection: an index failure cannot erase commit evidence. |
| D has committed but the initial reentry catalog/history evidence read fails | With a transient failure, the bounded recheck may establish `committed`; with every evidence read unavailable, return D's `commit-unknown`. Never return `not-committed`; removing faults then establishes exact D. Cover catalog and history reads separately, including exported D overwritten by a later manual revision. |
| D or an unchanged completion is already past the guard and deferred; engage `WriteGuard` before reentry, or configure all new replacement CAS calls to miss; then release the old mutation | Reentry with negative evidence remains the same `commit-unknown`; it never submits a replacement/status write, reaches its guard-refusal branch, or consumes the eight-conflict budget. The previously delegated write may still return `matchedCount:1`. Repeat after an actual newer revision/token fences it and assert `matchedCount:0` without turning negative evidence into noncommit. Keep the fresh-token guard and eight-acknowledged-miss `not-committed` cases above. |
| Reenter an uncertain valid UUID with malformed rows/dates, or call `beginDiscoveryAttempt` again for that same running UUID before reentry | Reconcile only; new validation failure or a reread of the existing claim cannot restore eligibility or disprove the original mutation. Fresh locally acquired tokens still reject malformed rows/dates before submission and allow a corrected safe retry. |
| A fresh submission pauses before a definite read/guard refusal; expire A and acquire B on the same store; B submits and becomes unknown; release A's refusal, then reenter B | A's proven `not-committed` result cannot replace/reset B's consumed entry. B reentry remains unknown with no extra mutation; release B's old write and assert its expected matched count and exact state. Repeat when B is still ready: A cannot erase B's ability to make its first submission. |
| A's new claim reaches Mongo but its acknowledgment is held; expire A, acquire B on the same store, then release A's acknowledgment | The delayed A acknowledgment must not replace B's local proof. Ready B can make its first submission; if B already became uncertain, reentry remains unknown. Persisted B token/lease/revision still fence all late A completions. |
| Two simultaneous `applyDiscovery` calls share a newly acquired token; pause the first before its first read completes | The first consumes proof before yielding; the second only reconciles. At most one submission enters the write loop. After a definite initial refusal, a later safe retry works; after uncertainty, all later calls stay reconciliation-only. |
| Mutation throws before applying, immediate reads miss, delayed write applies afterward | `commit-unknown` returned with original ID; no automatic replay/failure recording; later history/envelope demonstrates one commit. Repeat with a newer winner before delayed application and assert old CAS matches zero. |
| Unchanged status mutation applies/throws, or is delayed until after negative read | Positive same-attempt evidence gives unchanged; otherwise `commit-unknown`, no freshness until actual application. A takeover or manual revision advance fences the delayed update. |
| Every export boundary fails; fresh store recovers | Already committed catalog readable; `recoveryPending:true`; new writer blocked until export durable; exact one history/change per operation. |
| Duplicate matching/mismatched history/change; concurrent recovery; delivery mutated | Matching duplicates accepted; mismatch leaves slot and diagnostic; mutable delivery untouched; old slot clear cannot clear a newer commit's slot. |
| One provider export fails in all-provider recovery | Other providers still recover; per-provider error preserved; no timer or global rejection. |
| `faultDb(recordingDb, intercept).collection(name, JOURNALED)` → `createIndex` and delegated write | Underlying `collection` receives the exact name/options; inherited write concern and method binding survive. Also exercise omitted options. Do not fake a successful index/write to satisfy the assertion. |
| Unknown manual provider with plugin IDs `["sol"]` | Validation text remains `Unknown provider 'zeta'. Valid: claude, grok, codex, sol.`; built-in order matches existing admin behavior. |

- [ ] **Step 5:** Verify `npx vitest run src/admin/model-catalog-value.test.ts src/admin/model-catalog-store.test.ts` and `npm run typecheck`. Expected: deterministic schedules pass with no pending promise leaks; no raw Mongo error text. Commit Tasks 3/4 with `git commit -m "feat: persist catalog replacements with recoverable CAS exports"`.

## Task 5 — Delegate the manual tool to the shared writer

**Files:** Modify `src/admin/admin-mcp-server.ts:233–268,379–395,1233–1342`, `src/admin/admin-mcp-server.test.ts:26–113,1028–1140,1499–1555`.

- [ ] **Step 1:** Remove the private `AgentModelCatalogEntry/Doc/Version` definitions and obsolete comment asserting no live subscription model surfaces. Import `CatalogDoc as AgentModelCatalogDoc` from the shared types, `ModelCatalogStore` from the store and `diffText` from the value module. Keep the list-entry type, `CuratedCatalogProvider` alias (or alias it to `CatalogProvider`), Gemini code and `CURATED_CATALOG_PROVIDERS` ordering unchanged. Construct `const catalogStore = new ModelCatalogStore(db, { listPluginProviderIds: deps.listPluginProviderIds });` inside `buildAdminTools`, where `db` is already guarded. Remove the private catalog versions collection and its index from the existing agent-definition index initializer; the shared store owns catalog indexes. Do not add an SDK/discovery import to the admin server.
- [ ] **Step 2:** Replace the complete refresh handler body with this code. Keep existing Zod schema and response wording, while enforcing validation in the store. The narrow catch constructs a safe diagnostic; no `String(err)` escapes this write path.

```ts
async ({ provider, models, changeSummary }) => {
  try {
    const result = await catalogStore.replaceManual({ provider, models, updatedBy: agentId, changeSummary });
    if (result.kind === "committed") {
      return { content: [{ type: "text", text: `${provider} catalog updated: ${diffText(result.added, result.removed)}. ${models.length} models total.${changeSummary ? ` — ${changeSummary}` : ""}${result.recoveryPending ? " Catalog saved; audit/change recovery pending." : ""}` }] };
    }
    if (result.kind === "commit-unknown") return { isError: true, content: [{ type: "text", text: `Catalog commit outcome unknown (operation ${result.operationId}); reconcile this operation before retrying.` }] };
    if (result.kind === "not-committed") return { isError: true, content: [{ type: "text", text: result.error.message }] };
    return { isError: true, content: [{ type: "text", text: "Catalog replacement was not accepted." }] };
  } catch { return { isError: true, content: [{ type: "text", text: "Model catalog storage unavailable." }] }; }
}
```

Update tool descriptions precisely: built-in catalogs are shared between subscription discovery and full manual replacement; the manual tool itself makes no vendor calls; plugins remain manual; the next successful built-in discovery replaces membership/names/order while retaining notes. `list` still reads persisted built-ins and live Gemini and does not trigger built-in discovery. Do not claim an automatic timer runs before KPR-460 lands.

- [ ] **Step 3:** Replace only the catalog portion of the admin test fake with `createCatalogFake`. Retain agent-definition/version fakes untouched. Reset the catalog fake in existing `beforeEach` blocks, route the three exact catalog collection names to its `db.collection`, and replace catalog-array assertions with `[...fake.rows("agent_model_catalog_versions").values()]`. Seed legacy list fixtures directly through `fake.rows("agent_model_catalog")`. Do not mock `ModelCatalogStore` or preserve the old two-write mock. The `.models` optional type must be narrowed safely in list iteration (`for (const m of doc.models ?? [])`), keeping unseeded notes exactly as before.
- [ ] **Step 4:** Extend admin tests for empty models with bypassed Zod; duplicate IDs; plugin actor/diff/summary; identical audit; notes clearing; Gemini/unknown rejection; committed with projection pending is a success with explicit saved message; unknown acknowledgment returns stable operation ID without a false failure/success claim. Retain the existing `Valid: claude, grok, codex, sol` assertion for unknown providers with plugin `sol`; do not reorder that expected output. Existing list JSON, Gemini 10-minute cache and honest failure cases remain unchanged.
- [ ] **Step 5:** Run `npx vitest run src/admin/admin-mcp-server.test.ts src/admin/model-catalog-store.test.ts` and `npm run typecheck`. Expected: all old compatibility assertions and new shared-writer cases pass. Commit with `git commit -m "refactor: share manual model catalog persistence"`, staging only these two admin files.

## Task 6 — Real standalone integration, documentation, and final checks

**Files:** Create `src/admin/testing/standalone-mongo.ts`, `src/admin/model-catalog-store.integration.test.ts`; modify `docs/providers.md:57–71`, `CLAUDE.md:256,291`.

- [ ] **Step 1:** Add the isolated process harness. Local integration uses a new random port, a new data directory, and a new random test DB; readiness belongs to the child we spawned. No URI configuration or application startup is involved. Keep `MONGOD_BINARY` optional and never fall back to an existing service when spawn fails.

```ts
// src/admin/testing/standalone-mongo.ts
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { MongoClient } from "mongodb";
async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => { const address = server.address(); const port = typeof address === "object" && address ? address.port : 0; server.close((error) => error ? reject(error) : port && port !== 27017 ? resolve(port) : reject(new Error("No isolated test port"))); }); });
}
async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolve) => { const timer = setTimeout(() => child.kill("SIGKILL"), 5_000); child.once("exit", () => { clearTimeout(timer); resolve(); }); child.kill("SIGTERM"); });
}
export async function startStandaloneMongo() {
  const port = await freePort(), directory = await mkdtemp(join(tmpdir(), "hive-kpr459-mongo-"));
  let child: ChildProcess;
  try { child = spawn(process.env.MONGOD_BINARY || "mongod", ["--dbpath", directory, "--bind_ip", "127.0.0.1", "--port", String(port), "--storageEngine", "wiredTiger", "--nounixsocket", "--setParameter", "diagnosticDataCollectionEnabled=false"], { stdio: ["ignore", "pipe", "pipe"] }); } catch (error) { await rm(directory, { recursive: true, force: true }); throw error; }
  let client: MongoClient | undefined;
  const close = async () => { try { await client?.close(); } finally { try { await stop(child); } finally { await rm(directory, { recursive: true, force: true }); } } };
  try {
    await new Promise<void>((resolve, reject) => {
      let logs = "";
      const timer = setTimeout(() => finish(new Error("Owned standalone mongod did not become ready")), 20_000);
      const finish = (error?: Error) => { clearTimeout(timer); child.removeListener("error", onError); child.removeListener("exit", onExit); child.stdout?.removeListener("data", onData); child.stderr?.removeListener("data", onData); if (error) reject(error); else resolve(); };
      const onError = () => finish(new Error("Unable to spawn mongod; install a local MongoDB server or set MONGOD_BINARY"));
      const onExit = () => finish(new Error("Owned mongod exited before readiness"));
      const onData = (chunk: Buffer) => { logs = (logs + chunk.toString()).slice(-64 * 1024); if (logs.includes("Waiting for connections")) finish(); };
      child.once("error", onError); child.once("exit", onExit); child.stdout?.on("data", onData); child.stderr?.on("data", onData);
    });
    // Drain output after readiness so the child cannot block on a full pipe.
    child.stdout?.resume(); child.stderr?.resume();
    client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true&retryWrites=false`, { serverSelectionTimeoutMS: 3_000, monitorCommands: true });
    await client.connect(); const db = client.db(`hive_kpr459_test_${randomUUID().replaceAll("-", "")}`);
    const hello = await db.admin().command({ hello: 1 }), status = await db.admin().command({ serverStatus: 1 });
    if (hello.setName || status.storageEngine?.name !== "wiredTiger") throw new Error("Integration requires standalone WiredTiger");
    return { db, client, close };
  } catch (error) { await close(); throw error; }
}
```

- [ ] **Step 2:** Add the integration suite with `beforeAll/afterAll` using this harness (30-second hook limits), and `beforeEach` calling `dropDatabase` only on its generated DB. Assert its name starts `hive_kpr459_test_` before every destructive test reset. Wire `faultDb` around the real Db, then `guardDb` around that where testing identity refusal. Run the same persisted-state schedules from Task 4 against real Mongo; representative complete tests below define the delayed-write and restart patterns. Use injected fixed clocks for unit schedules. Real lease fixtures use timestamps relative to the server clock (or explicitly expire the fixture lease in the isolated DB) so `$$NOW` remains authoritative. Use generated UUIDs, real journaled writes, and operation-specific fault predicates so a fault is not consumed by index/recovery traffic.

```ts
// In src/admin/model-catalog-store.integration.test.ts (imports plus suite setup)
import { beforeAll, afterAll, beforeEach, describe, it, expect } from "vitest";
import { ModelCatalogStore } from "./model-catalog-store.js";
import { startStandaloneMongo } from "./testing/standalone-mongo.js";
import { faultDb } from "./testing/catalog-db.test-support.js";
let mongo: Awaited<ReturnType<typeof startStandaloneMongo>>;
beforeAll(async () => { mongo = await startStandaloneMongo(); }, 30_000);
afterAll(async () => { await mongo?.close(); }, 30_000);
beforeEach(async () => { expect(mongo.db.databaseName).toMatch(/^hive_kpr459_test_/); await mongo.db.dropDatabase(); });
const input = (id: string) => ({ provider: "codex", updatedBy: "test-operator", models: [{ id, displayName: id }] });
describe("standalone model catalog", () => {
  it("recovers a committed envelope through a fresh store", async () => {
    const broken = faultDb(mongo.db, async (collection, method, _args, run) => {
      if (collection === "agent_model_catalog_versions" && method === "insertOne") throw new Error("test history unavailable"); return run();
    });
    const result = await new ModelCatalogStore(broken).replaceManual(input("model-a"));
    expect(result).toMatchObject({ kind: "committed", recoveryPending: true });
    const fresh = new ModelCatalogStore(mongo.db); expect((await fresh.readCatalogState("codex")).snapshot?.models?.[0].id).toBe("model-a");
    expect(await fresh.recoverPendingExports("codex")).toEqual([{ provider: "codex", kind: "recovered" }]);
    expect(await fresh.collections.versions.countDocuments()).toBe(1); expect(await fresh.collections.changes.countDocuments()).toBe(1);
    expect((await fresh.readCatalogState("codex")).recoveryPending).toBe(false);
  });
  it("does not replay when a failed acknowledgment precedes the actual commit", async () => {
    let delayed: (() => Promise<any>) | undefined;
    const uncertain = faultDb(mongo.db, async (collection, method, args, run) => {
      if (!delayed && collection === "agent_model_catalog" && method === "insertOne" && args[0].pendingExport) { delayed = run; throw new Error("test lost acknowledgment before server execution"); } return run();
    });
    const result = await new ModelCatalogStore(uncertain).replaceManual(input("model-a"));
    expect(result.kind).toBe("commit-unknown"); expect(await mongo.db.collection("agent_model_catalog").countDocuments()).toBe(0);
    await delayed!(); const fresh = new ModelCatalogStore(mongo.db); await fresh.recoverPendingExports("codex");
    const version = await fresh.collections.versions.findOne({});
    expect(version?._id).toBe(result.kind === "commit-unknown" ? result.operationId : "unexpected");
    expect(await fresh.collections.versions.countDocuments()).toBe(1); expect(await fresh.collections.changes.countDocuments()).toBe(1);
  });
});
```

- [ ] **Step 3:** Complete real integration coverage with barriers around delegated real operations, not fake CAS responses: concurrent first inserts, observed-revision conflicts, late manual/discovery notes, unchanged status revision race, two claims and expiry takeover, all export failure boundaries, duplicate immutable mismatch, concurrent recoveries, mutated delivery retention, ambiguous post-commit ack, delayed unchanged success with negative reconciliation read, delayed old token after takeover, and late old CAS after a new manual winner. For the unchanged ambiguity case, seed → begin UUID attempt → delay matching `$set["scan.outcome"] === "succeeded"` update without `pendingExport` → throw → assert unknown and old freshness → run delayed mutation → assert updated freshness and unchanged history count. Repeat after manual revision advance/takeover and assert delayed update `matchedCount === 0`. Use a fresh store object for all recovery assertions. Include both positive-evidence combined D schedules from Task 4: delayed discovery commit becomes visible before re-entry or between its negative history read and failing recovery, and the same attempt returns the exact committed identity with recovery pending. For the first schedule, also use a fresh store with faulted index creation; positive evidence must settle the result before that write. Verify no extra replacement, revision, history, or change is created, then remove the projection fault and recover D exactly once.

Run every new unresolved-UUID reentry schedule from Task 4 against the real isolated Mongo process, preserving the original delegated operation and asserting its eventual real `matchedCount`. In particular: negative reconciliation plus a failing recovery read stays unknown until the deferred write commits; faulted fresh-store index initialization cannot convert the result to noncommit (reentry itself makes zero index calls); and a committed UUID with unavailable initial/all evidence reads yields positive recovery or the same unknown UUID. Exercise both original and fresh stores, transient and persistent catalog/history read faults, guard engagement after the original write passed the guard, eight-conflict traps on any attempted replay, invalid reentry input, same-token begin rereads, simultaneous applies, late A refusal after successor B becomes ready/uncertain, and late A claim acknowledgment after B acquires the provider. Assert no replay, extra UUID/revision/history/change, or false successful freshness. Faults are targeted per operation, barriers are released in `finally`, and every delayed operation is awaited. Initial genuinely fresh guard/read/index/recovery refusals and eight acknowledged misses must still produce retriable `not-committed` and allow a safe retry.

Instrument `client.on("commandStarted")`: assert catalog state-transition insert/update commands and both catalog history/change `createIndexes` commands include `writeConcern:{w:1,j:true}` through `faultDb`, no `startTransaction`, `autocommit:false`, `commitTransaction`, `abortTransaction`, or `$changeStream`. Driver implicit `lsid` is allowed and is not a dependency on application-managed sessions. Assert existing ObjectId history rows survive and no TTL index is created. Guard test engages `WriteGuard`, attempts replace/begin/apply/fail/recover, and checks catalog/history/outbox unchanged; reads still work and returned diagnostics omit raw DB details. Add the exact unchanged-completion guard schedule from Task 4 after successful index initialization, catalog seeding, and attempt acquisition; engage immediately before delegation, assert a single guard refusal and retriable storage `not-committed`, and compare complete pre/post catalog, scan freshness, history, and changes. Reads still work and neither replacement nor success status reaches Mongo. The manual handler integration uses the existing SDK `tool` mock solely to obtain the real handler, with a fresh guarded real test Db; Gemini remains mocked.

- [ ] **Step 4:** Update documentation with this behavior (adapt surrounding prose without changing unrelated provider matrix rows):

> The agent model catalog stores full replacement lists for Claude, Codex, Grok, and registered plugin providers. Built-in subscription discovery uses Claude SDK control-only `supportedModels`, the ChatGPT Codex models endpoint, and Grok's CLI proxy endpoint; it has no generation or API-key/public-catalog fallback. Claude accepts recognized stored subscription labels or the configured subscription OAuth-token source, each with first-party routing and no API-key evidence. Unsupported/ambiguous auth leaves the catalog manually maintained. A manual refresh takes effect immediately and never advances discovery freshness. The next successful built-in discovery replaces membership, display names, and order while retaining notes for retained IDs. Plugins stay manual and Gemini stays live with its existing cache. Catalog replacements share a journaled CAS writer with a bounded recovery envelope, append-only version history, and durable `agent_model_catalog_changes` records for bootstrap/ID differences. A saved catalog with audit/change recovery pending remains readable. An unknown commit outcome carries an operation ID and must be reconciled before retrying. This child provides discovery and durable primitives; scanner scheduling/status presentation and CoS delivery arrive through KPR-460/KPR-461.

In `CLAUDE.md` update the catalog paragraph and add `agent_model_catalog_changes` to the existing engine-written collection inventory, describing pending delivery ownership without claiming delivery exists yet. Preserve Gemini/API-key fallback documentation, LLM sidecar separation, and assignment behavior.

- [ ] **Step 5:** Format changed TypeScript files with `npx prettier --write` and explicit file paths from the file map; then run unit, integration, adjacent regression, `npm run check`, and `npm run build`. Expected: all tests pass, no skipped integration suite, zero type/lint/format failures, and successful build. Inspect `git diff --check` and `git diff --stat`: changes are limited to this plan's file map. Confirm no production `MongoClient`, timers, dispatcher changes, generated default catalog, API-key model discovery, or writes under `agents/` were added. Commit integration/docs with `git commit -m "test: verify standalone catalog recovery and discovery boundaries"` after staging exact files.

## Handoff to Siblings

KPR-460 receives `discoverProviderModels(provider,{signal})`, `beginDiscoveryAttempt`, `applyDiscovery`, `failDiscoveryAttempt`, `readCatalogState`, and `recoverPendingExports`. It supplies unique UUID attempt tokens, due-time decisions and a lease longer than the 60-second discovery bound plus commit allowance; manual writes never control cadence. `committed/recoveryPending` and `commit-unknown` are storage outcomes, not discovery failures. Use a new attempt only when the prior token's outcome is resolved or safely superseded by lease rules; do not automatically rerun manual replacements. Keep the store that definitively acquired a fresh claim for its initial `applyDiscovery` submission. A restarted/other store, an existing-token begin reread, or a repeated call after uncertainty can reconcile/recover the same UUID but cannot infer that it was never submitted. A fresh store waits for positive evidence or safe supersession under the existing lease rules; it does not blindly resume a running token. No new persisted status field or public method argument is added.

KPR-461 receives `collections.changes`, `pendingChanges`, immutable `CatalogChange`, initial `ChangeDelivery`, and recoverable versions. It may extend the separate delivery subdocument with claims/retries/recipient/ack fields while preserving immutable payloads and `commitId` work identity. It owns delivery status type extensions, its pending-query semantics, and all routing/dispatch decisions. Pending delivery never blocks the writer after export is durable.

## Assumptions and Review Notes

- The broad auth-selector exclusion is intentional; `CLAUDE_CONFIG_DIR` and subscription OAuth are the only retained Claude environment configuration. Stored CLI metadata must pass the account evidence gate even with settings sources disabled.
- The attempt UUID doubles as discovery operation UUID, giving unchanged and changed completion a common stable identity without adding a second persisted status ledger. Unknown negative reads remain unknown; they are not proof of non-commit.
- Read/catalog acknowledgment uncertainty is conservative. If unchanged-success evidence has already been superseded, return unknown instead of claiming a newer snapshot was validated.
- The integration binary is an external test prerequisite already available on the reviewed Mac. Missing binary on another runner requires harness setup or a concrete blocker, never production DB fallback or `it.skip`.
- No human plan approval is requested here; clean independent plan review and the epic waterfall maturity gate remain required before execution.
