/**
 * Installed runtime-probe evidence surfaces (KPR-463 plan chunk 5 Task 8
 * Step 6a.1a / Task 9 Step 5a.1a): current-readback rules for the bridge,
 * worker HTTP and heartbeat, the outbound trunk relationship, the service
 * environment fence and the error-to-classification mapping.
 *
 * Every vendor boundary is an injected `fetch`/lister; no operator config,
 * Keychain, launchd or real vendor connection is used, and no credential ever
 * reaches an assertion's expected value.
 */
import { describe, expect, it, vi } from "vitest";
import { buildServiceEnvironment } from "./services.js";
import {
  PRIVATE_INPUT_MODES,
  assertRuntimeProbeEnvironment,
  classifyWorkerHeartbeatDocument,
  probeBridge,
  probeOutboundSetup,
  probeWorkerHttp,
  runtimeProbeErrorResult,
  workerHttpRegistered,
} from "./runtime-probe.js";
import type { BootIdentity, Release } from "./release.js";

const RELEASE: Release = {
  schemaVersion: 1,
  packageVersion: "1.2.3",
  sourceRevision: "c".repeat(40),
  sourceDirty: false,
  dependencyLockSha256: "d".repeat(64),
  voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
};

const IDENTITY: BootIdentity = {
  release: RELEASE,
  component: "voice-worker",
  pid: 4242,
  bootId: "33333333-3333-4333-8333-333333333333",
  startedAt: "2026-09-14T10:00:00.000Z",
};

const BRIDGE = "http://127.0.0.1:8123/v1/chat/completions";
const TOKEN = "dummy-bridge-token";

function response(status: number, body?: unknown): Response {
  return {
    status,
    json: async () => {
      if (body === undefined) throw new Error("no body");
      return body;
    },
  } as unknown as Response;
}

const MISSING_AGENT = { error: "call.metadata.hive_agent_id required" };

describe("private probe modes", () => {
  it("names exactly the modes that take one sealed input path", () => {
    expect(PRIVATE_INPUT_MODES).toEqual(["worker-maintenance", "pilot", "pilot-inventory", "pilot-abi-v1"]);
    // The public modes are deliberately not in that set.
    for (const mode of ["config", "bridge", "worker", "outbound", "pilot-abi"]) {
      expect(PRIVATE_INPUT_MODES as readonly string[]).not.toContain(mode);
    }
  });
});

describe("service environment fence", () => {
  const home = "/Users/example";
  const base = {
    hiveHome: "/Users/example/services/hive/dodi",
    configPath: "/Users/example/services/hive/dodi/hive.yaml",
    home,
    pathEnv: "/usr/bin:/bin",
    overrides: {},
  };

  it("accepts exactly the environment the service definition builds", () => {
    const environment = buildServiceEnvironment(base);
    expect(assertRuntimeProbeEnvironment(environment)).toEqual(environment);
  });

  it("refuses an incomplete environment", () => {
    const environment = buildServiceEnvironment(base);
    for (const key of ["HIVE_HOME", "HIVE_CONFIG", "HOME", "PATH"]) {
      const { [key]: _removed, ...partial } = environment;
      void _removed;
      expect(() => assertRuntimeProbeEnvironment(partial)).toThrow(/service environment incomplete/);
    }
  });

  it("refuses an environment carrying anything the service definition would not set", () => {
    const environment = buildServiceEnvironment(base);
    for (const extra of [
      { ANTHROPIC_API_KEY: "sk-secret" },
      { LIVEKIT_API_SECRET: "dummy-secret" },
      { NODE_OPTIONS: "--inspect" },
    ]) {
      expect(() => assertRuntimeProbeEnvironment({ ...environment, ...extra })).toThrow(
        /differs from service environment/,
      );
    }
    expect(assertRuntimeProbeEnvironment({ ...environment, __CF_USER_TEXT_ENCODING: "0x1F5:0x0:0x0" })).toEqual(
      environment,
    );
    expect(
      assertRuntimeProbeEnvironment({
        ...environment,
        TMPDIR: "/tmp/job/tmp",
        npm_config_cache: "/tmp/job/npm-cache",
        npm_config_update_notifier: "false",
      }),
    ).toEqual(environment);
  });

  it("accepts a valid port override and refuses a malformed one", () => {
    const withOverride = buildServiceEnvironment({ ...base, overrides: { VOICE_PORT: "8123" } });
    expect(assertRuntimeProbeEnvironment(withOverride)).toEqual(withOverride);
    expect(() => assertRuntimeProbeEnvironment({ ...withOverride, VOICE_PORT: "0" })).toThrow(
      /invalid service port override/,
    );
    expect(() => assertRuntimeProbeEnvironment({ ...withOverride, VOICE_PORT: "eighty" })).toThrow(
      /invalid service port override/,
    );
  });
});

describe("bridge readback", () => {
  it("is authenticated only when the exact missing-agent body and both denials hold", async () => {
    const fetchImpl = vi.fn(async (_url: unknown, init?: RequestInit) => {
      const authorization = (init?.headers as Record<string, string> | undefined)?.Authorization;
      if (authorization === `Bearer ${TOKEN}`) return response(400, MISSING_AGENT);
      if (authorization === undefined) return response(401);
      return response(403);
    });
    const result = await probeBridge(BRIDGE, TOKEN, fetchImpl as unknown as typeof fetch, () => "independent-wrong");
    expect(result).toMatchObject({
      authenticated: true,
      missingDenied: true,
      wrongDenied: true,
      classification: "bridge-authenticated",
    });
    // Three probes: correct, missing, wrong — never more.
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("refuses a copied or padded 400 body as authentication", async () => {
    for (const body of [{ error: "call.metadata.hive_agent_id required", extra: 1 }, { error: "something else" }, {}]) {
      const result = await probeBridge(
        BRIDGE,
        TOKEN,
        (async () => response(400, body)) as unknown as typeof fetch,
        () => "independent-wrong",
      );
      expect(result.classification).toBe("bridge-authentication-failed");
      expect(result.authenticated).toBe(false);
    }
  });

  it("treats a 200 on the correct token as unauthenticated evidence", async () => {
    const result = await probeBridge(
      BRIDGE,
      TOKEN,
      (async () => response(200, { ok: true })) as unknown as typeof fetch,
      () => "independent-wrong",
    );
    expect(result).toMatchObject({ authenticated: false, classification: "bridge-authentication-failed" });
  });

  it("reports unreachable rather than inventing statuses", async () => {
    const result = await probeBridge(
      BRIDGE,
      TOKEN,
      (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
      () => "independent-wrong",
    );
    expect(result).toEqual({
      authenticated: false,
      missingDenied: false,
      wrongDenied: false,
      correctStatus: null,
      missingStatus: null,
      wrongStatus: null,
      classification: "bridge-unreachable",
    });
  });

  it("requires a configured token and an independent wrong token", async () => {
    await expect(probeBridge(BRIDGE, "", undefined, () => "x")).rejects.toThrow(/missing configured token/);
    await expect(probeBridge(BRIDGE, TOKEN, undefined, () => TOKEN)).rejects.toThrow(/independent wrong token/);
    await expect(probeBridge(BRIDGE, TOKEN, undefined, () => "")).rejects.toThrow(/independent wrong token/);
  });
});

describe("worker HTTP readback", () => {
  it("is registered only on a 200 root, the pinned agent name and a real job count", () => {
    expect(workerHttpRegistered({ rootStatus: 200, agentName: "hive-voice", activeJobs: 0 })).toBe(true);
    expect(workerHttpRegistered({ rootStatus: 200, agentName: "hive-voice", activeJobs: 3 })).toBe(true);
    // Zero jobs is a real count; an absent count is not.
    expect(workerHttpRegistered({ rootStatus: 200, agentName: "hive-voice", activeJobs: null })).toBe(false);
    expect(workerHttpRegistered({ rootStatus: 200, agentName: "other-agent", activeJobs: 0 })).toBe(false);
    expect(workerHttpRegistered({ rootStatus: 503, agentName: "hive-voice", activeJobs: 0 })).toBe(false);
    expect(workerHttpRegistered({ rootStatus: null, agentName: null, activeJobs: null })).toBe(false);
  });

  it("reads the agent name and job count, and leaves malformed evidence unavailable", async () => {
    const ok = await probeWorkerHttp(8081, (async (url: string) =>
      url.endsWith("/worker")
        ? response(200, { agent_name: "hive-voice", active_jobs: 2 })
        : response(200)) as unknown as typeof fetch);
    expect(ok).toEqual({ rootStatus: 200, agentName: "hive-voice", activeJobs: 2 });

    const malformed = await probeWorkerHttp(8081, (async (url: string) =>
      url.endsWith("/worker")
        ? response(200, { agent_name: 7, active_jobs: "2" })
        : response(200)) as unknown as typeof fetch);
    expect(malformed).toEqual({ rootStatus: 200, agentName: null, activeJobs: null });

    const unreadable = await probeWorkerHttp(8081, (async (url: string) =>
      url.endsWith("/worker") ? response(200) : response(200)) as unknown as typeof fetch);
    expect(unreadable).toEqual({ rootStatus: 200, agentName: null, activeJobs: null });
  });

  it("reports nothing at all when the worker is unreachable, and refuses an invalid port", async () => {
    const unreachable = await probeWorkerHttp(8081, (async () => {
      throw new Error("ECONNREFUSED");
    }) as unknown as typeof fetch);
    expect(unreachable).toEqual({ rootStatus: null, agentName: null, activeJobs: null });
    for (const port of [0, -1, 65_536, 1.5]) {
      await expect(probeWorkerHttp(port)).rejects.toThrow(/invalid worker health port/);
    }
  });
});

describe("worker heartbeat classification", () => {
  const now = Date.parse("2026-09-14T10:05:00.000Z");
  const fresh = new Date(now - 10_000);

  it("reads a fresh document with its identity and active-call count", () => {
    expect(
      classifyWorkerHeartbeatDocument(
        { supervisorIdentity: IDENTITY, supervisorUpdatedAt: fresh, activeCalls: 2 },
        now,
      ),
    ).toMatchObject({ fresh: true, ageMs: 10_000, activeCalls: 2 });
  });

  it("accepts an ISO string timestamp and rejects an unparsable one", () => {
    expect(
      classifyWorkerHeartbeatDocument({ supervisorIdentity: IDENTITY, supervisorUpdatedAt: fresh.toISOString() }, now)
        .fresh,
    ).toBe(true);
    const unparsable = classifyWorkerHeartbeatDocument(
      { supervisorIdentity: IDENTITY, supervisorUpdatedAt: "later today" },
      now,
    );
    expect(unparsable).toMatchObject({ ageMs: null, fresh: false });
    expect(unparsable.identity).not.toBeNull();
  });

  it("is not fresh when stale or implausibly far in the future", () => {
    expect(
      classifyWorkerHeartbeatDocument(
        { supervisorIdentity: IDENTITY, supervisorUpdatedAt: new Date(now - 60_001) },
        now,
      ).fresh,
    ).toBe(false);
    expect(
      classifyWorkerHeartbeatDocument({ supervisorIdentity: IDENTITY, supervisorUpdatedAt: new Date(now + 5_001) }, now)
        .fresh,
    ).toBe(false);
    // A small clock skew toward the future is tolerated.
    expect(
      classifyWorkerHeartbeatDocument({ supervisorIdentity: IDENTITY, supervisorUpdatedAt: new Date(now + 1_000) }, now)
        .fresh,
    ).toBe(true);
  });

  it("leaves everything unavailable when the identity is absent or malformed", () => {
    for (const value of [null, "document", 7, {}, { supervisorIdentity: { pid: 4242 } }]) {
      expect(classifyWorkerHeartbeatDocument(value, now)).toEqual({
        identity: null,
        ageMs: null,
        fresh: false,
        activeCalls: null,
      });
    }
  });

  it("refuses a stringified or negative active-call count", () => {
    for (const activeCalls of ["2", -1, 1.5, null]) {
      expect(
        classifyWorkerHeartbeatDocument({ supervisorIdentity: IDENTITY, supervisorUpdatedAt: fresh, activeCalls }, now)
          .activeCalls,
      ).toBeNull();
    }
  });
});

describe("outbound trunk relationship", () => {
  const input = {
    sipTrunkId: "ST_abc",
    twilioNumber: "+15551234567",
    twilioTrunkDomain: "sip:example.pstn.twilio.com/",
  };
  const trunk = { sipTrunkId: "ST_abc", numbers: ["+15551234567"], address: "example.pstn.twilio.com" };

  it("matches read-only when the trunk, number and normalized domain all agree", async () => {
    expect(await probeOutboundSetup(input, async () => [trunk])).toMatchObject({
      ok: true,
      classification: "outbound-read-only-match",
      trunkExists: true,
    });
  });

  it("reports a missing trunk rather than guessing another one", async () => {
    expect(await probeOutboundSetup(input, async () => [{ ...trunk, sipTrunkId: "ST_other" }])).toMatchObject({
      ok: false,
      classification: "outbound-trunk-missing",
      trunkExists: false,
    });
    expect(await probeOutboundSetup(input, async () => [])).toMatchObject({ classification: "outbound-trunk-missing" });
  });

  it("reports a relationship mismatch when the number or domain disagrees", async () => {
    expect(await probeOutboundSetup(input, async () => [{ ...trunk, numbers: ["+15559999999"] }])).toMatchObject({
      ok: false,
      classification: "outbound-relationship-mismatch",
      numberMatches: false,
      domainMatches: true,
    });
    expect(await probeOutboundSetup(input, async () => [{ ...trunk, address: "other.pstn.twilio.com" }])).toMatchObject(
      {
        classification: "outbound-relationship-mismatch",
        numberMatches: true,
        domainMatches: false,
      },
    );
    expect(
      await probeOutboundSetup({ ...input, twilioNumber: "", twilioTrunkDomain: "" }, async () => [trunk]),
    ).toMatchObject({ classification: "outbound-relationship-mismatch", numberMatches: false, domainMatches: false });
  });

  it("requires a configured trunk id", async () => {
    await expect(probeOutboundSetup({ ...input, sipTrunkId: "" }, async () => [trunk])).rejects.toThrow(
      /outbound trunk ID missing/,
    );
  });
});

describe("probe error classification", () => {
  it("names a missing engine or worker key without leaking its value", () => {
    expect(runtimeProbeErrorResult(new Error("Missing required env var: SLACK_BOT_TOKEN"))).toEqual({
      ok: false,
      classification: "missing-required-key",
      missingSecretNames: ["SLACK_BOT_TOKEN"],
    });
    expect(runtimeProbeErrorResult(new Error("voice worker missing required config: livekitApiSecret"))).toMatchObject({
      missingSecretNames: ["LIVEKIT_API_SECRET"],
    });
    expect(runtimeProbeErrorResult(new Error("voice worker missing required config: bridgeToken"))).toMatchObject({
      missingSecretNames: ["HIVE_VOICE_BRIDGE_TOKEN"],
    });
    expect(runtimeProbeErrorResult(new Error("CARTESIA_API_KEY missing for the configured voice"))).toMatchObject({
      missingSecretNames: ["CARTESIA_API_KEY"],
    });
  });

  it("maps the known maintenance faults and defaults to probe-failed", () => {
    expect(runtimeProbeErrorResult(new Error("ledger persistence-fault observed"))).toMatchObject({
      classification: "persistence-fault",
      missingSecretNames: [],
    });
    expect(runtimeProbeErrorResult(new Error("maintenance request timed out"))).toMatchObject({
      classification: "maintenance request timed out",
    });
    expect(runtimeProbeErrorResult(new Error("stale or mismatched maintenance reply"))).toMatchObject({
      classification: "stale or mismatched maintenance reply",
    });
    expect(runtimeProbeErrorResult(new Error("maintenance-unresolved"))).toMatchObject({
      classification: "maintenance-unresolved",
    });
    expect(runtimeProbeErrorResult(new Error("something entirely unexpected"))).toEqual({
      ok: false,
      classification: "probe-failed",
      missingSecretNames: [],
    });
    expect(runtimeProbeErrorResult("not an error")).toMatchObject({ classification: "probe-failed" });
  });

  it("never echoes the failing message or a credential value into the result", () => {
    const rendered = JSON.stringify(
      runtimeProbeErrorResult(new Error("connect failed to mongodb://user:sekret@127.0.0.1/hive")),
    );
    expect(rendered).not.toContain("sekret");
    expect(rendered).not.toContain("mongodb://");
  });
});
