/**
 * Strict pilot probe ABI decoders and projections (KPR-463 plan chunk 5
 * Task 8 Step 6a.1a / Task 9 Step 5a.1a). Everything here is pure or reads a
 * temp tree: no operator config, Keychain, launchd or vendor call, and no
 * `held=true` constructor is ever injected.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  HISTORICAL_PROBE_ABI,
  HISTORICAL_SERVER_SDK,
  MAX_PROBE_OUTPUT_BYTES,
  PILOT_REQUIRED_NATIVE_ARTIFACTS,
  ProbeFailure,
  TELEMETRY_MAX_AGE_MS,
  WORKER_MAINTENANCE_ABI,
  allSipPages,
  classificationOf,
  countInventory,
  decodePilotAbiHandshake,
  decodeProbeFailure,
  dependencyFile,
  historicalIdle,
  historicalIdleRequest,
  historicalRequestPath,
  historicalTelemetry,
  inventoryDigest,
  inventoryItem,
  inventoryItems,
  pilotConfigIdentity,
  pilotConfigProjection,
  pilotProbeRequestPath,
  probeClassifications,
  resolveRequiredNativeArtifacts,
  sameDependencySet,
  sha256Canonical,
  sortInventory,
  type InventoryItem,
  type PilotConfigLoaderShape,
} from "./pilot-probe.js";
import { RecordDecodeError } from "./pilot-records.js";
import { writeNativeFixtureArtifacts } from "./testing/pilot-fixture.js";
import type { InstanceKey } from "./pilot-records.js";
import type { Release } from "./release.js";

/**
 * Strict record decoding raises `RecordDecodeError`; the probe's own
 * classified faults raise `ProbeFailure`. Either is a refusal; returning is
 * not. Never assert merely "threw" — a decoder that leaked a vendor error
 * would pass that.
 */
function refuses(run: () => unknown): void {
  let thrown: unknown = null;
  try {
    run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown instanceof ProbeFailure || thrown instanceof RecordDecodeError).toBe(true);
}

async function refusesAsync(run: () => Promise<unknown>): Promise<void> {
  let thrown: unknown = null;
  try {
    await run();
  } catch (error) {
    thrown = error;
  }
  expect(thrown instanceof ProbeFailure || thrown instanceof RecordDecodeError).toBe(true);
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const RELEASE: Release = {
  schemaVersion: 1,
  packageVersion: "1.2.3",
  sourceRevision: "c".repeat(40),
  sourceDirty: false,
  dependencyLockSha256: "d".repeat(64),
  voiceWorker: { path: "pkg/voice-worker.min.js", admissionProtocol: 1 },
};

const INSTANCE: InstanceKey = {
  canonicalHome: "/Users/example/services/hive/dodi",
  configPath: "/Users/example/services/hive/dodi/hive.yaml",
  instanceId: "dodi",
  uid: 501,
};

const SUPERVISOR = {
  release: RELEASE,
  component: "voice-worker" as const,
  pid: 4242,
  bootId: "33333333-3333-4333-8333-333333333333",
  startedAt: "2026-09-14T10:00:00.000Z",
};

describe("fixed probe classifications", () => {
  it("never invents a classification and defaults input-invalid", () => {
    expect(classificationOf(new ProbeFailure("PILOT_TELEMETRY_STALE"))).toBe("PILOT_TELEMETRY_STALE");
    // A bare Error whose message happens to be a fixed code is accepted as it.
    expect(classificationOf(new Error("PILOT_BRIDGE_FAILED"))).toBe("PILOT_BRIDGE_FAILED");
    // Anything else — including raw vendor text — collapses to input-invalid.
    expect(classificationOf(new Error("ECONNREFUSED 10.0.0.1:443 token=abc"))).toBe("PILOT_PROBE_INPUT_INVALID");
    expect(classificationOf("PILOT_TELEMETRY_STALE")).toBe("PILOT_PROBE_INPUT_INVALID");
    expect(classificationOf(undefined)).toBe("PILOT_PROBE_INPUT_INVALID");
  });

  it("carries only its classification, never the cause's text", () => {
    const failure = new ProbeFailure("PILOT_LOADER_UNAVAILABLE", { cause: new Error("secret-token-xyz") });
    expect(failure.message).toBe("PILOT_LOADER_UNAVAILABLE");
    expect(JSON.stringify({ message: failure.message })).not.toContain("secret-token-xyz");
    expect(probeClassifications).toContain(failure.classification);
  });

  it("decodes a failure envelope only for its own ABI and a fixed classification", () => {
    const envelope = {
      schemaVersion: 1,
      abi: WORKER_MAINTENANCE_ABI,
      requestId: "44444444-4444-4444-8444-444444444444",
      classification: "PILOT_PROBE_DEADLINE",
    };
    expect(decodeProbeFailure(envelope, WORKER_MAINTENANCE_ABI)).toMatchObject({
      classification: "PILOT_PROBE_DEADLINE",
    });
    refuses(() => decodeProbeFailure(envelope, HISTORICAL_PROBE_ABI));
    refuses(() => decodeProbeFailure({ ...envelope, schemaVersion: 2 }, WORKER_MAINTENANCE_ABI));
    refuses(() => decodeProbeFailure({ ...envelope, classification: "SOMETHING_ELSE" }, WORKER_MAINTENANCE_ABI));
    // An unknown key is not silently tolerated.
    refuses(() => decodeProbeFailure({ ...envelope, extra: 1 }, WORKER_MAINTENANCE_ABI));
  });
});

describe("pilot ABI handshake", () => {
  const handshake = {
    schemaVersion: 1,
    abi: HISTORICAL_PROBE_ABI,
    projection: 1,
    serverSdk: HISTORICAL_SERVER_SDK,
    operations: ["observe", "inventory"],
    release: RELEASE,
  };

  it("accepts exactly the pinned ABI, projection, SDK and operation set", () => {
    expect(decodePilotAbiHandshake(handshake)).toMatchObject({ abi: HISTORICAL_PROBE_ABI, projection: 1 });
  });

  it("refuses a different ABI, projection, SDK, operation order or extra operation", () => {
    for (const bad of [
      { ...handshake, abi: "hive-pilot-probe/2" },
      { ...handshake, projection: 2 },
      { ...handshake, serverSdk: "2.15.0" },
      { ...handshake, operations: ["inventory", "observe"] },
      { ...handshake, operations: ["observe", "inventory", "close"] },
      { ...handshake, operations: "observe,inventory" },
      { ...handshake, schemaVersion: "1" },
    ]) {
      refuses(() => decodePilotAbiHandshake(bad));
    }
  });

  it("refuses a missing or malformed release and a non-object value", () => {
    refuses(() => decodePilotAbiHandshake({ ...handshake, release: { ...RELEASE, sourceRevision: "short" } }));
    for (const bad of [null, [], "handshake", 1]) refuses(() => decodePilotAbiHandshake(bad));
  });
});

describe("historical telemetry and idle decoding", () => {
  const telemetry = {
    queryStartedAt: 1_760_000_000_000,
    queryFinishedAt: 1_760_000_000_100,
    supervisorIdentity: SUPERVISOR,
    supervisorUpdatedAt: 1_760_000_000_000,
    activeCalls: 0,
  };

  it("accepts a well-formed telemetry document", () => {
    expect(historicalTelemetry(telemetry)).toMatchObject({ activeCalls: 0 });
  });

  it("refuses stringified numbers, negative counts and unknown keys", () => {
    refuses(() => historicalTelemetry({ ...telemetry, activeCalls: "0" }));
    refuses(() => historicalTelemetry({ ...telemetry, activeCalls: -1 }));
    refuses(() => historicalTelemetry({ ...telemetry, queryStartedAt: "1760000000000" }));
    refuses(() => historicalTelemetry({ ...telemetry, unexpected: true }));
    refuses(() => historicalTelemetry({ ...telemetry, supervisorIdentity: { pid: 4242 } }));
  });

  it("requires the expected supervisor to be a voice worker", () => {
    const request = {
      expectedAdmission: "closed",
      expectedSupervisor: SUPERVISOR,
      statusRequestId: "55555555-5555-4555-8555-555555555555",
    };
    expect(historicalIdleRequest(request)).toMatchObject({ expectedAdmission: "closed" });
    expect(() =>
      historicalIdleRequest({ ...request, expectedSupervisor: { ...SUPERVISOR, component: "engine" } }),
    ).toThrow(ProbeFailure);
    // A boolean is not an admission state.
    refuses(() => historicalIdleRequest({ ...request, expectedAdmission: true }));
    refuses(() => historicalIdleRequest({ ...request, statusRequestId: "not-a-uuid" }));
  });

  it("classifies a malformed maintenance reply as an admission mismatch, not input-invalid", () => {
    expect(() =>
      historicalIdle({
        status: { requestedAt: 1, finishedAt: 2, reply: { ok: true } },
        telemetry,
      }),
    ).toThrow(new ProbeFailure("PILOT_ADMISSION_MISMATCH").message);
  });

  it("pins the telemetry freshness window as a constant, not a caller argument", () => {
    expect(TELEMETRY_MAX_AGE_MS).toBe(60_000);
    expect(MAX_PROBE_OUTPUT_BYTES).toBe(256 * 1024);
  });
});

describe("inventory projection", () => {
  const item = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
    kind: "room",
    id: "a".repeat(64),
    parent: null,
    agentName: "hive-voice",
    ...overrides,
  });

  it("retains every category and counts distinct ids per kind", () => {
    const items: InventoryItem[] = [
      item({ kind: "room", id: "1".repeat(64) }),
      item({ kind: "room", id: "1".repeat(64) }),
      item({ kind: "participant", id: "2".repeat(64), parent: "1".repeat(64) }),
      item({ kind: "dispatch", id: "3".repeat(64) }),
      item({ kind: "sip-rule", id: "4".repeat(64), agentName: null }),
      item({ kind: "inbound-trunk", id: "5".repeat(64), agentName: null }),
    ];
    expect(countInventory(items)).toEqual({
      rooms: 1,
      participants: 1,
      dispatches: 1,
      rules: 1,
      inboundTrunks: 1,
    });
    // Zero rooms and jobs does not zero the other categories.
    expect(countInventory(items.filter((entry) => entry.kind !== "room" && entry.kind !== "dispatch"))).toEqual({
      rooms: 0,
      participants: 1,
      dispatches: 0,
      rules: 1,
      inboundTrunks: 1,
    });
  });

  it("sorts deterministically and independently of input order", () => {
    const items = [item({ id: "2".repeat(64) }), item({ id: "1".repeat(64) })];
    expect(sortInventory(items).map((entry) => entry.id)).toEqual(sortInventory([...items].reverse()).map((e) => e.id));
    // Sorting never mutates its input.
    expect(items[0].id).toBe("2".repeat(64));
  });

  it("refuses an unknown kind, a raw id in place of a digest and an oversized list", () => {
    refuses(() => inventoryItem(item({ kind: "agent" as never })));
    refuses(() => inventoryItem({ ...item(), id: "room-1" }));
    refuses(() => inventoryItem({ ...item(), extra: 1 }));
    expect(inventoryItems([])).toEqual([]);
    refuses(() => inventoryItems(Array.from({ length: 10_001 }, () => item())));
    refuses(() => inventoryItems("items"));
  });

  it("hashes raw ids per operation and kind, and refuses control characters", () => {
    const left = inventoryDigest("op-1", "room", "room-A");
    expect(left).toMatch(/^[a-f0-9]{64}$/);
    expect(inventoryDigest("op-2", "room", "room-A")).not.toBe(left);
    expect(inventoryDigest("op-1", "dispatch", "room-A")).not.toBe(left);
    for (const raw of ["", "a\0b", "a\nb", "a\rb", "x".repeat(4097)]) {
      refuses(() => inventoryDigest("op-1", "room", raw));
    }
  });
});

describe("pinned SIP pagination", () => {
  const rows = (count: number, offset = 0) =>
    Array.from({ length: count }, (_, index) => ({ id: `r${offset + index}` }));

  it("reads a second page and stops on a short page", async () => {
    const pages: { limit: number; afterId: string }[] = [];
    const result = await allSipPages(
      async (page) => {
        pages.push(page);
        return page.afterId === "" ? rows(100) : rows(5, 100);
      },
      (row) => row.id,
    );
    expect(result).toHaveLength(105);
    expect(pages).toEqual([
      { limit: 100, afterId: "" },
      { limit: 100, afterId: "r99" },
    ]);
  });

  it("refuses a repeated cursor, a duplicate id, an oversized page and an unbounded scan", async () => {
    await refusesAsync(async () =>
      allSipPages(
        async () => rows(100, 0),
        (row: { id: string }) => row.id,
      ),
    );
    await refusesAsync(async () =>
      allSipPages(
        async () => rows(101),
        (row: { id: string }) => row.id,
      ),
    );
    await refusesAsync(async () =>
      allSipPages(
        async () => [{ id: "same" }, { id: "same" }],
        (row) => row.id,
      ),
    );
    await refusesAsync(async () =>
      allSipPages(
        async () => [{ id: "bad\nid" }],
        (row) => row.id,
      ),
    );
    await refusesAsync(async () =>
      allSipPages(
        async () => "not-an-array" as never,
        () => "x",
      ),
    );
  });
});

describe("configuration identity projection", () => {
  const loader: PilotConfigLoaderShape = {
    instanceHome: INSTANCE.canonicalHome,
    instanceId: INSTANCE.instanceId,
    mongoDbName: "hive",
    sipTrunkId: "ST_abc",
    inboundAgents: { "+15551234567": "rae" },
    agentVoices: { rae: "voice-1" },
    defaultStt: "deepgram/flux-general-en",
    defaultTts: "cartesia/sonic-3",
    bridgeUrl: "http://127.0.0.1:8123/v1/chat/completions",
  };

  it("projects only non-credential fields and is stable across calls", () => {
    const projection = pilotConfigProjection(loader, INSTANCE, 8081) as Record<string, unknown>;
    expect(projection).toMatchObject({ projection: 1, databaseName: "hive" });
    expect(JSON.stringify(projection)).not.toContain("password");
    expect(pilotConfigIdentity(loader, INSTANCE, 8081)).toBe(pilotConfigIdentity(loader, INSTANCE, 8081));
    expect(pilotConfigIdentity(loader, INSTANCE, 8081)).toBe(sha256Canonical(projection));
  });

  it("changes identity when any projected field changes", () => {
    const base = pilotConfigIdentity(loader, INSTANCE, 8081);
    expect(pilotConfigIdentity({ ...loader, defaultTts: "cartesia/sonic-2" }, INSTANCE, 8081)).not.toBe(base);
    expect(pilotConfigIdentity({ ...loader, sipTrunkId: "ST_other" }, INSTANCE, 8081)).not.toBe(base);
    expect(pilotConfigIdentity(loader, INSTANCE, 9090)).not.toBe(base);
  });

  it("refuses a credential-bearing, remote, query-carrying or wrong-path bridge URL", () => {
    for (const bridgeUrl of [
      "http://user:pass@127.0.0.1:8123/v1/chat/completions",
      "https://127.0.0.1:8123/v1/chat/completions",
      "http://10.0.0.5:8123/v1/chat/completions",
      "http://127.0.0.1:8123/v1/chat/completions?token=abc",
      "http://127.0.0.1:8123/v1/chat/completions#x",
      "http://127.0.0.1:8123/other",
      "not a url",
    ]) {
      refuses(() => pilotConfigProjection({ ...loader, bridgeUrl }, INSTANCE, 8081));
    }
  });

  it("refuses a loader whose instance disagrees with the request", () => {
    refuses(() => pilotConfigProjection({ ...loader, instanceId: "other" }, INSTANCE, 8081));
    refuses(() => pilotConfigProjection({ ...loader, instanceHome: "/elsewhere" }, INSTANCE, 8081));
  });
});

describe("dependency identity", () => {
  const file = {
    path: "/release/node_modules/livekit-server-sdk/index.js",
    realpath: "/release/node_modules/livekit-server-sdk/index.js",
    sha256: "e".repeat(64),
    version: "2.14.1",
  };

  it("decodes a dependency file and refuses a non-digest or relative path", () => {
    expect(dependencyFile(file)).toMatchObject({ version: "2.14.1" });
    expect(dependencyFile({ ...file, version: null })).toMatchObject({ version: null });
    refuses(() => dependencyFile({ ...file, sha256: "not-a-digest" }));
    refuses(() => dependencyFile({ ...file, path: "node_modules/x/index.js" }));
    refuses(() => dependencyFile({ ...file, extra: 1 }));
  });

  it("compares dependency sets exactly and order-independently", () => {
    const left = [
      { realpath: "/a", sha256: "1" },
      { realpath: "/b", sha256: "2" },
    ];
    expect(sameDependencySet(left, [...left].reverse())).toBe(true);
    expect(sameDependencySet(left, [{ realpath: "/a", sha256: "1" }])).toBe(false);
    expect(sameDependencySet(left, [left[0], { realpath: "/b", sha256: "9" }])).toBe(false);
    expect(sameDependencySet([], [])).toBe(true);
  });
});

describe("native artifact capture", () => {
  function closure(): { root: string; entry: string } {
    const root = realpathSync(mkdtempSync(resolve(tmpdir(), "hive-pilot-native-")));
    roots.push(root);
    mkdirSync(resolve(root, "pkg"), { recursive: true });
    const entry = resolve(root, "pkg", "runtime-probe.min.js");
    writeFileSync(entry, "// probe\n");
    for (const name of ["@livekit/rtc-node"]) {
      mkdirSync(resolve(root, "node_modules", name), { recursive: true });
      writeFileSync(
        resolve(root, "node_modules", name, "package.json"),
        JSON.stringify({ name, version: "0.13.33", main: "index.js" }),
      );
      writeFileSync(resolve(root, "node_modules", name, "index.js"), "module.exports = {};\n");
    }
    writeNativeFixtureArtifacts(root);
    return { root, entry };
  }

  it("declares a descriptor for each artifact no JS import graph can name", () => {
    expect(PILOT_REQUIRED_NATIVE_ARTIFACTS.map((artifact) => artifact.id)).toEqual([
      "rtc-addon",
      "onnx-runtime",
      "silero-model",
    ]);
    expect(PILOT_REQUIRED_NATIVE_ARTIFACTS.find((a) => a.id === "onnx-runtime")!.platformPartitioned).toBe(true);
  });

  it("captures the addon, the platform's shared library and the model, and nothing foreign", () => {
    const { root, entry } = closure();
    const captured = resolveRequiredNativeArtifacts(entry, [root]).map((item) => item.realpath.slice(root.length + 1));
    expect(captured).toContain(
      `node_modules/@livekit/rtc-ffi-bindings-${process.platform}-${process.arch}/rtc-node.${process.platform}-${process.arch}.node`,
    );
    expect(captured.filter((path) => path.includes("onnxruntime-node"))).toHaveLength(2);
    expect(captured.some((path) => path.includes("napi-v6/linux/x64"))).toBe(false);
    expect(captured.filter((path) => path.endsWith("silero_vad.onnx"))).toHaveLength(2);
  });

  it("fails rather than shrinking when an artifact package is absent or escapes the roots", () => {
    const { root, entry } = closure();
    expect(() => resolveRequiredNativeArtifacts(entry, [resolve(root, "pkg")])).toThrow("PILOT_DEPENDENCY_MISMATCH");
    rmSync(resolve(root, "node_modules", "onnxruntime-node"), { recursive: true, force: true });
    expect(() => resolveRequiredNativeArtifacts(entry, [root])).toThrow("PILOT_DEPENDENCY_MISMATCH");
  });
});

describe("request paths are derived, never accepted", () => {
  it("places each request under its own operation and request id", () => {
    const request = { operationId: "op-1", requestId: "req-1" };
    expect(pilotProbeRequestPath("/home/dodi", request, "pilot")).toBe(
      "/home/dodi/.hive-state/deployment/operations/op-1/probes/req-1/pilot.json",
    );
    expect(pilotProbeRequestPath("/home/dodi", request, "pilot-inventory")).toBe(
      "/home/dodi/.hive-state/deployment/operations/op-1/probes/req-1/pilot-inventory.json",
    );
    expect(historicalRequestPath("/home/dodi", request)).toBe(
      "/home/dodi/.hive-state/deployment/operations/op-1/probes/req-1/historical.json",
    );
  });
});
