# KPR-252 — Pool Loopback HTTP (keep-alive dispatcher) Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Eliminate per-request TCP churn from the engine's loopback/control-plane HTTP calls by installing a shared keep-alive `undici` dispatcher at every Hive process entry, so the registration loop and other loopback callers reuse connections instead of exhausting the macOS IPv4 ephemeral port range.

**Architecture:** A new `src/http/loopback-dispatcher.ts` module constructs one keep-alive `undici.Agent` (idle timeout deliberately **longer** than the 30s registration poll) and installs it as the global `fetch` dispatcher via `setGlobalDispatcher`. Every Hive process — the main engine (`src/index.ts`) and each stdio MCP subprocess (`background`, `code-task`, `task`) — calls `installKeepAliveDispatcher()` once at startup before any `fetch()`. The beekeeper registration loop additionally passes the shared dispatcher explicitly (belt-and-suspenders + testability) and the keep-alive-timeout-must-exceed-interval invariant is code-enforced and unit-tested.

**Tech Stack:** TypeScript (strict, Node 22+), `undici` (promoted from transitive to direct dep), Vitest, esbuild bundle.

## Background (root cause, confirmed in code)

`src/beekeeper-client.ts` re-POSTs to `http://127.0.0.1:<beekeeperPort>/internal/register-capability` every `intervalMs ?? 30_000` ms with a bare `fetch()`. Node's global fetch dispatcher keep-alive idle timeout (~4s) is shorter than the 30s poll, so the pooled socket closes between ticks and every tick opens a fresh TCP connection → `TIME_WAIT` accumulation → IPv4 ephemeral exhaustion → host-wide `EADDRNOTAVAIL`.

Same bare-`fetch()` anti-pattern at the other engine-originated loopback callers:

| Caller | Process | Target (default) |
|---|---|---|
| `src/beekeeper-client.ts` | main engine | `:<beekeeperPort>` (8420) — **confirmed primary churner** |
| `src/tasks/task-ledger.ts` (`TaskLedger`) | main engine | `config.taskLedger.apiUrl` (loopback `:3002`) |
| `src/tasks/task-client.ts` (`TaskClient`) | main engine | same `apiUrl` |
| `src/background/background-task-mcp-server.ts` | stdio subprocess | `:3100` |
| `src/code-task/code-task-mcp-server.ts` | stdio subprocess | `:3102` |
| `src/tasks/task-mcp-server.ts` | stdio subprocess | `:3002` |

Installing one global keep-alive dispatcher per process pools **all** of these (and outbound HTTPS) at once, matching ticket fix suggestions #1, #2, #4 with minimal surface area.

## Scope / Out of scope

**In scope (this branch, `@keepur/hive` only):**
- Shared keep-alive dispatcher module + install at every Hive process entry.
- Harden the beekeeper registration loop (explicit dispatcher + invariant + tests).

**Out of scope (note in PR, file follow-ups — do NOT implement here):**
- **Unix-domain socket control plane** (ticket suggestion #3): requires a coordinated `@keepur/beekeeper` change (separate repo). Follow-up ticket.
- **The `:3200` `/health` poll bucket**, if originated by the separate `node @keepur/beekeeper` process polling the hive's registered `healthUrl`: that client lives in the beekeeper repo. The hive change cannot pool a connection the hive does not originate. Call this out explicitly in the PR body.
- **Short-lived stdio subprocess caveat:** if an MCP subprocess is spawned per-turn and makes a single call before exiting, in-process keep-alive yields little (the socket closes at process exit regardless). The install is still correct and helps multi-call sessions; the durable fix for those is in-process clients or UDS. Note as a known limitation; do not re-architect here.

---

## Testing Contract

### Required Test Groups

- Unit: `required`
  - Scope: `src/http/loopback-dispatcher.ts` (dispatcher construction + keep-alive invariant constant).
  - Reason: The keep-alive-timeout-must-exceed-poll-interval relationship is the entire fix; a future edit shortening the timeout silently reintroduces the bug. Code-enforce it with a test.
  - Minimum assertions: `KEEPALIVE_TIMEOUT_MS > DEFAULT_REGISTRATION_INTERVAL_MS`; `createKeepAliveAgent()` returns an `undici.Agent` instance; `installKeepAliveDispatcher()` is idempotent (second call is a no-op / does not throw).

- Integration: `required`
  - Scope: connection reuse across sequential `fetch()` calls through the shared dispatcher, and across multiple beekeeper registration ticks.
  - Reason: The observable, regression-meaningful behavior is "N requests → 1 TCP connection". This is what the bug violated (N requests → N connections).
  - Harness: `existing` (Vitest + `node:http` `createServer`, same pattern as `src/beekeeper-client.test.ts`).
  - Minimum assertions:
    - `loopback-dispatcher.test.ts`: 5 sequential `fetch()` calls to a local server through one shared `createKeepAliveAgent()` → server observes exactly **1** TCP connection (`server.on("connection")` count === 1). **Negative control:** the same 5 calls each through a **fresh `createKeepAliveAgent()` per iteration** (its own pool) → count === **5** (proves the test detects churn; deterministic, no reliance on `connection: close` semantics).
    - `beekeeper-client.test.ts`: ≥3 registration ticks (short `intervalMs`) against a connection-counting local server, with an injected shared keep-alive dispatcher → server observes exactly **1** connection. **Negative control:** route each tick through a fresh agent → count === number of ticks.

- E2E: `not-required`
  - See Non-Required Rationale.

### Critical Flows

- Beekeeper registration loop reuses a single pooled connection across ticks (no new socket per 30s).
- All engine-originated loopback `fetch()` (task ledger, background/code-task/task MCP) inherit the global keep-alive dispatcher.
- stdio MCP subprocesses install the dispatcher **without** writing to `stdout` (JSON-RPC stream stays clean).

### Regression Surface

- `src/beekeeper-client.ts` existing behavior: payload shape unchanged (`name`/`localWsUrl`/`healthUrl`), immediate-then-interval POST cadence unchanged, no-crash-when-unreachable preserved.
- stdio MCP protocol integrity: the three MCP servers must not emit anything to `stdout` at startup (dispatcher module must not import the logger, which writes non-error logs to `process.stdout` — see `src/logging/logger.ts:22`).
- Bundle: `pkg/server.min.js` and the stdio MCP entry bundles still build (`npm run bundle` / `check:bundle`).

### Commands

- Unit: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm test -- src/http/loopback-dispatcher.test.ts`
- Integration: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm test -- src/beekeeper-client.test.ts src/http/loopback-dispatcher.test.ts`
- Broader regression: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
- Bundle gate: `npm run bundle`

### Harness Requirements

- Env stubs `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test` for any command that boots config (see reference: npm-check env stubs). `SLACK_BOT_TOKEN` is the one that actually trips.
- No external services, network, DB, or accounts required — all tests use in-process `node:http` loopback servers.

### Non-Required Rationale

- E2E: The fix is a transport-layer connection-pooling change with no user-facing surface. The "1 connection vs N" assertion at the integration layer is a faithful, deterministic proxy for the production symptom; a full host-level ephemeral-port-exhaustion repro is non-deterministic (depends on the wedged kernel reaper) and not reproducible in CI.

### Verification Rules

- Missing harness is not a skip reason; set it up or report a concrete blocker.
- If a test failure exposes an implementation issue, fix the implementation, not the test.
- If testing exposes a spec or plan mismatch, demote the ticket to the spec lane.

---

## File Structure

- **Create** `src/http/loopback-dispatcher.ts` — the only new responsibility: build + install the shared keep-alive dispatcher. Imports `undici` only (no logger → stdout-safe for stdio MCP).
- **Create** `src/http/loopback-dispatcher.test.ts` — unit + connection-reuse tests.
- **Modify** `package.json` — add `undici` to `dependencies`.
- **Modify** `src/index.ts` — install dispatcher at top of `main()`.
- **Modify** `src/background/background-task-mcp-server.ts`, `src/code-task/code-task-mcp-server.ts`, `src/tasks/task-mcp-server.ts` — install dispatcher at entry.
- **Modify** `src/beekeeper-client.ts` — export `DEFAULT_REGISTRATION_INTERVAL_MS`, accept optional `dispatcher` (defaults to shared), pass it to `fetch`, document invariant.
- **Modify** `src/beekeeper-client.test.ts` — add connection-reuse test.

---

### Task 1: Promote `undici` to a direct dependency

**Files:**
- Modify: `package.json` (`dependencies`)
- Modify: `package-lock.json` (regenerated)

- [ ] **Step 1:** Add `undici` to `dependencies` matching the already-resolved version. (`undici@^6.23.0` is already in the tree via `@qdrant/js-client-rest` — this only promotes the edge to direct so importing `Agent`/`setGlobalDispatcher` is hygienic and won't break on a future dedupe.)

```jsonc
// package.json — under "dependencies", in alphabetical position
"undici": "^6.23.0",
```

- [ ] **Step 2:** Refresh the lockfile (no new download expected; verify `undici@6.x`).

Run: `npm install`
Expected: `package-lock.json` updated; `node -e "console.log(require('undici/package.json').version)"` prints a `6.x` version. No major-version bump.

- [ ] **Step 3:** Sanity-check the import surface resolves.

Run: `node -e "const u=require('undici'); console.log(typeof u.Agent, typeof u.setGlobalDispatcher)"`
Expected: `function function`

- [ ] **Step 4:** Commit.

```bash
git add package.json package-lock.json
git commit -m "build(deps): promote undici to a direct dependency (KPR-252)"
```

---

### Task 2: Shared keep-alive dispatcher module + tests

**Files:**
- Create: `src/http/loopback-dispatcher.ts`
- Test: `src/http/loopback-dispatcher.test.ts`

- [ ] **Step 1:** Create the dispatcher module. **No logger import** — non-error logs go to `process.stdout` (`src/logging/logger.ts:22`), which would corrupt the stdio MCP JSON-RPC stream when this module is imported by an MCP subprocess.

```typescript
// src/http/loopback-dispatcher.ts
import { Agent, setGlobalDispatcher, type Dispatcher } from "undici";

/**
 * Keep-alive idle timeout (ms) for the shared fetch dispatcher.
 *
 * INVARIANT: this MUST stay strictly greater than the longest poll interval of
 * any loopback control-plane loop — currently the beekeeper registration loop
 * (`DEFAULT_REGISTRATION_INTERVAL_MS`, 30s in `src/beekeeper-client.ts`).
 *
 * If the idle timeout is shorter than a poll interval, the pooled socket goes
 * idle and closes between polls, so every tick opens a fresh TCP connection —
 * the exact churn that exhausts the macOS IPv4 ephemeral port range and breaks
 * all new IPv4 connections host-wide (KPR-252). The relationship is asserted in
 * loopback-dispatcher.test.ts.
 */
export const KEEPALIVE_TIMEOUT_MS = 60_000;

/** Upper bound undici will honor for a server-provided keep-alive hint. */
const KEEPALIVE_MAX_TIMEOUT_MS = 600_000;

/** Per-origin connection cap. The loopback control plane needs only a handful. */
const MAX_CONNECTIONS_PER_ORIGIN = 16;

let shared: Agent | undefined;
let installed = false;

/** Construct a keep-alive Agent tuned for connection reuse. Exposed for tests. */
export function createKeepAliveAgent(): Agent {
  return new Agent({
    keepAliveTimeout: KEEPALIVE_TIMEOUT_MS,
    keepAliveMaxTimeout: KEEPALIVE_MAX_TIMEOUT_MS,
    connections: MAX_CONNECTIONS_PER_ORIGIN,
    connect: { timeout: 10_000 },
  });
}

/** Process-wide shared keep-alive dispatcher (lazily created). */
export function getLoopbackDispatcher(): Dispatcher {
  if (!shared) shared = createKeepAliveAgent();
  return shared;
}

/**
 * Install the shared keep-alive Agent as this process's global fetch dispatcher.
 * Idempotent. Call ONCE at every Hive process entry (main engine + each stdio
 * MCP subprocess) BEFORE any fetch() is issued. Pools all outbound HTTP —
 * loopback control plane (beekeeper registration, task ledger, background /
 * code-task managers) and external HTTPS alike — eliminating per-request TCP
 * churn (KPR-252).
 *
 * Intentionally silent: no logging, so importing this from a stdio MCP server
 * cannot pollute the JSON-RPC stdout stream.
 */
export function installKeepAliveDispatcher(): void {
  if (installed) return;
  setGlobalDispatcher(getLoopbackDispatcher());
  installed = true;
}
```

- [ ] **Step 2:** Write the tests.

```typescript
// src/http/loopback-dispatcher.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import {
  KEEPALIVE_TIMEOUT_MS,
  createKeepAliveAgent,
  installKeepAliveDispatcher,
} from "./loopback-dispatcher.js";
import { DEFAULT_REGISTRATION_INTERVAL_MS } from "../beekeeper-client.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("loopback-dispatcher", () => {
  let server: Server | undefined;
  let agent: Agent | undefined;

  afterEach(async () => {
    if (agent) {
      await agent.close();
      agent = undefined;
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("keep-alive idle timeout exceeds the registration poll interval", () => {
    // The core invariant of the fix (KPR-252).
    expect(KEEPALIVE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REGISTRATION_INTERVAL_MS);
  });

  it("installKeepAliveDispatcher is idempotent", () => {
    expect(() => {
      installKeepAliveDispatcher();
      installKeepAliveDispatcher();
    }).not.toThrow();
  });

  it("reuses a single TCP connection across sequential requests", async () => {
    let connections = 0;
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server.on("connection", () => {
      connections += 1;
    });
    const port = await listen(server);
    agent = createKeepAliveAgent();

    for (let i = 0; i < 5; i++) {
      // `dispatcher` is a documented field on RequestInit (via @types/node →
      // undici-types) in this repo — no cast needed.
      const res = await fetch(`http://127.0.0.1:${port}/`, { dispatcher: agent });
      await res.text();
    }

    expect(connections).toBe(1);
  });

  it("negative control: a fresh dispatcher per request opens one socket each", async () => {
    // Proves the connection counter detects churn: without a shared pool, each
    // request rides its own Agent (its own pool) and opens a new TCP connection.
    let connections = 0;
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server.on("connection", () => {
      connections += 1;
    });
    const port = await listen(server);

    for (let i = 0; i < 5; i++) {
      const perCall = createKeepAliveAgent();
      const res = await fetch(`http://127.0.0.1:${port}/`, { dispatcher: perCall });
      await res.text();
      await perCall.close();
    }

    expect(connections).toBe(5);
  });
});
```

> Note: this test imports `DEFAULT_REGISTRATION_INTERVAL_MS` from `../beekeeper-client.js`, which is added in Task 5. If implementing Task 2 before Task 5, add the export first (Task 5, Step 1) or temporarily inline `30_000` and switch to the import when Task 5 lands. Prefer doing Task 5 Step 1 first.

- [ ] **Step 3:** Verify.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm test -- src/http/loopback-dispatcher.test.ts`
Expected: 4 passing tests (invariant, idempotent, reuse===1, negative===5).

- [ ] **Step 4:** Commit.

```bash
git add src/http/loopback-dispatcher.ts src/http/loopback-dispatcher.test.ts
git commit -m "feat(http): shared keep-alive loopback dispatcher (KPR-252)"
```

---

### Task 3: Install the dispatcher at the main engine entry

**Files:**
- Modify: `src/index.ts` (top of `main()`, before any fetch / before `startBeekeeperRegistration`)

- [ ] **Step 1:** Add the import alongside the other top-level imports in `src/index.ts`.

```typescript
import { installKeepAliveDispatcher } from "./http/loopback-dispatcher.js";
```

- [ ] **Step 2:** Call it as the very first statement inside `main()` (before MongoClient, adapters, or the beekeeper loop start). Locate `async function main()` and insert immediately after the opening brace.

```typescript
async function main(): Promise<void> {
  // KPR-252: pool all outbound HTTP (loopback control plane + external) behind a
  // single keep-alive dispatcher before any fetch() runs, so the registration
  // loop and task-ledger clients reuse connections instead of exhausting the
  // IPv4 ephemeral port range. Must run before startBeekeeperRegistration().
  installKeepAliveDispatcher();
  // ...existing first line of main() follows...
```

- [ ] **Step 3:** Verify it compiles and the engine still type-checks.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4:** Commit.

```bash
git add src/index.ts
git commit -m "feat(engine): install keep-alive dispatcher at startup (KPR-252)"
```

---

### Task 4: Install the dispatcher in the stdio MCP subprocesses

**Files:**
- Modify: `src/background/background-task-mcp-server.ts`
- Modify: `src/code-task/code-task-mcp-server.ts`
- Modify: `src/tasks/task-mcp-server.ts`

- [ ] **Step 1:** In each of the three files, add the import after the existing imports and call `installKeepAliveDispatcher()` immediately, before the first `fetch()` / tool registration. The relative path is `../http/loopback-dispatcher.js` for all three (each lives one directory under `src/`).

For `src/background/background-task-mcp-server.ts` — after the `import { z } from "zod";` line:

```typescript
import { installKeepAliveDispatcher } from "../http/loopback-dispatcher.js";

// KPR-252: reuse loopback connections to the background-task manager across the
// session instead of a fresh socket per tool call. Silent install — must not
// write to stdout (JSON-RPC stream).
installKeepAliveDispatcher();
```

For `src/code-task/code-task-mcp-server.ts` — same import + call after `import { z } from "zod";` (comment references the code-task manager).

For `src/tasks/task-mcp-server.ts` — same import + call. Place the `installKeepAliveDispatcher()` call **after** the existing `if (!API_KEY) { ... process.exit(1); }` guard (no reason to install a dispatcher in a process that's about to exit), but before the `api()` helper is ever invoked.

- [ ] **Step 2:** Confirm no `stdout` pollution — the dispatcher module imports only `undici` and logs nothing. Grep to be sure none of the three files now import the logger transitively for this purpose.

Run: `grep -n "installKeepAliveDispatcher\|logging/logger" src/background/background-task-mcp-server.ts src/code-task/code-task-mcp-server.ts src/tasks/task-mcp-server.ts`
Expected: each file shows the `installKeepAliveDispatcher` import + call; **no** `logging/logger` import added.

- [ ] **Step 3:** Verify type-check.

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 4:** Commit.

```bash
git add src/background/background-task-mcp-server.ts src/code-task/code-task-mcp-server.ts src/tasks/task-mcp-server.ts
git commit -m "feat(mcp): install keep-alive dispatcher in stdio task servers (KPR-252)"
```

---

### Task 5: Harden the beekeeper registration loop

**Files:**
- Modify: `src/beekeeper-client.ts`
- Test: `src/beekeeper-client.test.ts`

- [ ] **Step 1:** Export the interval default and route the registration POST through the shared dispatcher (explicit, so it's correct even if the global install order ever changes, and so the loop is unit-testable with an injected dispatcher). Replace the top imports + options interface + `register` body in `src/beekeeper-client.ts`.

```typescript
import { createLogger } from "./logging/logger.js";
import { getLoopbackDispatcher } from "./http/loopback-dispatcher.js";
import type { Dispatcher } from "undici";

const log = createLogger("beekeeper-client");

/**
 * Default re-registration interval (ms).
 *
 * INVARIANT: the shared keep-alive dispatcher's idle timeout
 * (`KEEPALIVE_TIMEOUT_MS` in src/http/loopback-dispatcher.ts) MUST exceed this,
 * or the pooled socket closes between ticks and we churn a new connection every
 * poll — KPR-252. Asserted in loopback-dispatcher.test.ts.
 */
export const DEFAULT_REGISTRATION_INTERVAL_MS = 30_000;

export interface BeekeeperRegistrationOptions {
  beekeeperPort: number;
  wsPort: number;
  /** Capability name to register with beekeeper. Defaults to "hive". */
  capabilityName?: string;
  /** Test-only override. Defaults to DEFAULT_REGISTRATION_INTERVAL_MS. */
  intervalMs?: number;
  /** Test-only override. Defaults to the shared keep-alive loopback dispatcher. */
  dispatcher?: Dispatcher;
}
```

Update the `intervalMs` default and add the dispatcher resolution + pass it to `fetch`:

```typescript
export function startBeekeeperRegistration(opts: BeekeeperRegistrationOptions): BeekeeperRegistrationHandle {
  const { beekeeperPort, wsPort } = opts;
  const intervalMs = opts.intervalMs ?? DEFAULT_REGISTRATION_INTERVAL_MS;
  const dispatcher = opts.dispatcher ?? getLoopbackDispatcher();

  const url = `http://127.0.0.1:${beekeeperPort}/internal/register-capability`;
  const payload = {
    name: opts.capabilityName ?? "hive",
    localWsUrl: `ws://127.0.0.1:${wsPort}`,
    healthUrl: `http://127.0.0.1:${wsPort}/health`,
  };
  const body = JSON.stringify(payload);

  const register = async (): Promise<void> => {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        dispatcher,
      });
      if (res.ok) {
        log.debug("Registered with beekeeper", { beekeeperPort, wsPort });
      } else {
        const text = await res.text().catch(() => "");
        log.warn("Beekeeper registration failed", { status: res.status, body: text });
      }
    } catch (err) {
      log.warn("Beekeeper registration error", { error: String(err) });
    }
  };

  // Fire-and-forget initial registration.
  void register();
  const handle = setInterval(() => {
    void register();
  }, intervalMs);

  return {
    stop: () => clearInterval(handle),
  };
}
```

> No cast is needed: this repo has no DOM lib in `tsconfig.json`, so global `fetch`/`RequestInit` resolve via `@types/node` → `undici-types`, whose `RequestInit` already declares `dispatcher?: Dispatcher`. Pass `dispatcher` inline as shown. Also: **preserve the existing file-level docstring (current lines 1–11)** — only the imports, the options interface, and the `register()`/defaults are being changed, not the top-of-file comment block.

- [ ] **Step 2:** Add a connection-reuse test to `src/beekeeper-client.test.ts`. Add inside the existing `describe("startBeekeeperRegistration", ...)` block; import `createKeepAliveAgent` + `Agent` at the top.

```typescript
// add to imports at top of the file:
import { createKeepAliveAgent } from "./http/loopback-dispatcher.js";
```

```typescript
  it("reuses a single TCP connection across registration ticks", async () => {
    let connections = 0;
    const agent = createKeepAliveAgent();
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/internal/register-capability") {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.on("connection", () => {
      connections += 1;
    });
    const port = await listen(server);

    stopHandle = startBeekeeperRegistration({
      beekeeperPort: port,
      wsPort: 4321,
      intervalMs: 20,
      dispatcher: agent,
    });

    // Wait until several ticks have fired (well past 3 × 20ms).
    await new Promise((resolve) => setTimeout(resolve, 150));
    stopHandle.stop();
    stopHandle = undefined;
    await agent.close();

    // All ticks rode one pooled connection, not one socket per tick.
    expect(connections).toBe(1);
  });
```

> The existing two tests (`POSTs ... immediately and re-POSTs`, `does not crash when beekeeper is unreachable`) must continue to pass unchanged — they exercise the default-dispatcher path. The `afterEach` already calls `stopHandle?.stop()` and closes `server`.

- [ ] **Step 3:** Verify.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm test -- src/beekeeper-client.test.ts src/http/loopback-dispatcher.test.ts`
Expected: all tests pass — existing beekeeper tests + new reuse test (connections===1), and the dispatcher suite.

- [ ] **Step 4 (negative-verify the regression test):** Temporarily reintroduce the churn pattern in `src/beekeeper-client.ts` — replace the reused `dispatcher` with a **fresh agent per call** so each tick opens its own pool/socket. This is deterministic (no reliance on `connection: close` semantics). Inside `register()`, temporarily change the `dispatcher` reference passed to `fetch` to `createKeepAliveAgent()` (importing it locally), i.e. a new pool every tick. Confirm the "reuses a single TCP connection across registration ticks" test **fails** with `connections` ≈ number of ticks. Then restore the fix (single shared `dispatcher`).

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm test -- src/beekeeper-client.test.ts`
Expected (with a fresh agent per tick): the reuse test fails (`connections > 1`). Restore the file and confirm it passes again. (Evidence the test detects the bug — per negative-verify regression-test practice.)

- [ ] **Step 5:** Commit.

```bash
git add src/beekeeper-client.ts src/beekeeper-client.test.ts
git commit -m "fix(beekeeper-client): pool registration loop via keep-alive dispatcher (KPR-252)"
```

---

### Task 6: Full verification + bundle gate

**Files:** none (verification only)

- [ ] **Step 1:** Full repo check.

Run: `SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npm run check`
Expected: typecheck + lint + format + test all green.

- [ ] **Step 2:** Bundle gate (catches esbuild / entry-point issues for `pkg/server.min.js` and the stdio MCP entries; the new import must resolve in the bundle).

Run: `npm run bundle`
Expected: bundle succeeds; `check:bundle` gates pass.

- [ ] **Step 3:** Confirm no stray `stdout` writes were introduced into the stdio MCP servers (final integrity check).

Run: `grep -n "console.log\|process.stdout" src/background/background-task-mcp-server.ts src/code-task/code-task-mcp-server.ts src/tasks/task-mcp-server.ts`
Expected: no matches (other than any pre-existing — there should be none).

- [ ] **Step 4:** No commit needed (verification only). Proceed to `dodi-dev:review`.

---

## Execution Handoff

Plan saved to `docs/plans/2026-06-19-kpr-252-pool-loopback-http.md`. When ready, invoke `dodi-dev:implement`.
