/**
 * Beekeeper federation client — Phase A.
 *
 * Periodically advertises this Hive instance to a sibling Beekeeper on the
 * same box via HTTP POST to /internal/register-capability. Loopback-only,
 * additive to existing legacy WS paths.
 *
 * Strategy is intentionally simple: POST immediately, then re-POST every
 * `intervalMs` (default 30s). No backoff, no jitter, no readiness probe.
 * Errors are swallowed and logged — the loop keeps running.
 */

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

export interface BeekeeperRegistrationHandle {
  stop: () => void;
}

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
      // The global `RequestInit` resolves to the DOM lib variant in this
      // project (a transitive dep pulls in lib.dom), which lacks undici's
      // `dispatcher` field. Pass it via a typed intersection rather than
      // weakening to `any` — the runtime fetch is undici's and honors it.
      const init: RequestInit & { dispatcher: Dispatcher } = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        dispatcher,
      };
      const res = await fetch(url, init);
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
