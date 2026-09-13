/**
 * Loopback VoiceAdapter fixture: a real adapter HTTP server on an ephemeral
 * port, wired to a fake registry / memory manager / AgentManager whose
 * `spawnTurn` is the caller-supplied fake. Shared by
 * voice-adapter.integration.test.ts (KPR-219/322/464/465) and the KPR-465 R6
 * bench loopback test (scripts/voice-engine-bench.test.ts).
 *
 * Test-only. Importers MUST declare the same file-level `vi.mock` block as
 * voice-adapter.integration.test.ts (logger with a `vi.fn()` `writeTracked`,
 * SDK, prompt-builder, config) — mocks are per test file, so this module
 * cannot declare them itself. `engineRows()` reads the mocked logger.
 */
import { vi, type Mock } from "vitest";
import { request as httpRequest, type ClientRequest, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";

import { createLogger } from "../../../logging/logger.js";
import { VoiceAdapter } from "../voice-adapter.js";
import type { TurnContext, TurnResult } from "../../../agents/agent-manager.js";
import type { Dispatcher } from "../../dispatcher.js";

/** The one agent id the fixture's fake registry resolves. */
export const FIXTURE_AGENT_ID = "mokie";

/** Bridge bearer token used by worker-shaped (LiveKit bridge) requests. */
export const BRIDGE_TOKEN = "tok-1";

export type FakeSpawn = (ctx: TurnContext, onStream?: (chunk: string) => void) => Promise<TurnResult>;

export interface CapturedSpawn {
  ctx: TurnContext;
  onStream?: (chunk: string) => void;
}

/** Explicit (not inferred) so declaration emit never has to name vitest-internal types. */
export interface AdapterFixture {
  adapter: VoiceAdapter;
  captured: CapturedSpawn[];
  sessionStoreGet: ReturnType<typeof vi.fn>;
  sessionStoreSet: Mock;
  spawnTurn: Mock<FakeSpawn>;
}

export function makeAdapter(opts: {
  /** Resolved by spawnTurn; behavior may include onStream chunks. */
  spawn: FakeSpawn;
  /** What the session-store returns on get(agentId, threadId). */
  storedSessionId?: string;
  /**
   * KPR-223: optional dispatcher mock. When provided, the adapter is
   * constructed with the dispatcher so voice turns route through
   * `dispatcher.routeVoiceTurn` instead of directly through
   * `agentManager.spawnTurn`. Omit to keep the legacy fallback wiring.
   */
  dispatcher?: Dispatcher;
  /** KPR-322 E1: override VAPI_SERVER_SECRET (default "shared-secret"). */
  serverSecret?: string;
  /** KPR-322 E1: HIVE_VOICE_BRIDGE_TOKEN (default "" = LiveKit disabled). */
  bridgeToken?: string;
  /** KPR-322 E2: abort in-flight spawn for a thread. */
  abortThread?: (agentId: string, threadId: string) => unknown;
  /** KPR-322 E2: override session-store get (hanging pre-spawn gate). */
  sessionStoreGet?: ReturnType<typeof vi.fn>;
}): AdapterFixture {
  const captured: CapturedSpawn[] = [];
  const sessionStoreGet =
    opts.sessionStoreGet ??
    vi
      .fn()
      .mockResolvedValue(opts.storedSessionId ? { sessionId: opts.storedSessionId, provider: "claude" } : undefined);
  const sessionStoreSet = vi.fn().mockResolvedValue(undefined);

  const spawnTurn = vi.fn(async (ctx: TurnContext, onStream?: (chunk: string) => void) => {
    captured.push({ ctx, onStream });
    return await opts.spawn(ctx, onStream);
  });

  const abortThread = opts.abortThread ?? vi.fn().mockReturnValue(false);

  const registry: any = {
    get: vi.fn((id: string) =>
      id === FIXTURE_AGENT_ID ? { id: FIXTURE_AGENT_ID, name: "Mokie", model: "claude-sonnet-4-6" } : undefined,
    ),
  };
  const memoryManager: any = {
    read: vi.fn().mockResolvedValue(""),
    getHotTierPrompt: vi.fn().mockResolvedValue(""),
  };
  const agentManager: any = {
    spawnTurn,
    abortThread,
    getSessionStore: () => ({ get: sessionStoreGet, set: sessionStoreSet }),
    providerFor: vi.fn().mockReturnValue("claude"),
  };

  const serverSecret = opts.serverSecret ?? "shared-secret";
  const bridgeToken = opts.bridgeToken ?? "";
  const adapter = opts.dispatcher
    ? new VoiceAdapter(0, serverSecret, bridgeToken, registry, memoryManager, agentManager, opts.dispatcher)
    : new VoiceAdapter(0, serverSecret, bridgeToken, registry, memoryManager, agentManager);
  return { adapter, captured, sessionStoreGet, sessionStoreSet, spawnTurn };
}

/** Starts the adapter on its OS-assigned ephemeral port. The caller owns `setup.adapter.stop()`. */
export async function startAdapter(
  setup: AdapterFixture,
): Promise<{ server: { address: () => AddressInfo | string | null }; port: number }> {
  await setup.adapter.start();
  const server = (setup.adapter as any).httpServer as { address: () => AddressInfo };
  const addr = server.address();
  return { server, port: addr.port };
}

export function postChatCompletion(
  port: number,
  opts: { headers?: Record<string, string>; body: Record<string, unknown> },
): Promise<{ status: number; headers: IncomingMessage["headers"]; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(opts.body);
    const req: ClientRequest = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
          // Vapi default — auth comes from assistant.metadata.hive_agent_id.
          authorization: "Bearer no-credentials-provided",
          ...opts.headers,
        },
      },
      (res) => {
        const chunks: string[] = [];
        res.on("data", (c) => chunks.push(c.toString("utf-8")));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, headers: res.headers, chunks }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

/** The adapter's `voice_diagnostic` trace rows (optionally one event), read off the mocked logger's `writeTracked`. */
export function engineRows(event?: string): Array<Record<string, unknown>> {
  const writeTracked = (
    createLogger("voice-adapter-fixture") as unknown as { writeTracked?: { mock?: { calls: unknown[][] } } }
  ).writeTracked;
  if (!writeTracked?.mock) {
    throw new Error(
      "engineRows() needs the logger module mocked with a vi.fn() writeTracked — copy the vi.mock block from voice-adapter.integration.test.ts",
    );
  }
  return writeTracked.mock.calls
    .map((call) => call[2] as Record<string, unknown>)
    .filter((row) => row?.kind === "voice_diagnostic" && (!event || row.event === event));
}
