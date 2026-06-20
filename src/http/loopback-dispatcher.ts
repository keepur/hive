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
