import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { finishOperationLock, writeOperationJson } from "./operation.js";
import {
  currentHoldCapability,
  loadRegisteredPilot,
  observeRegisteredPilotRecovery,
  reconcileRegistryWork,
  registryPilotEvidence,
  runInventoryPilot,
  runPrepareLegacyHold,
  runReleaseLegacyHold,
  runVerifyLegacyHold,
  type PilotServiceReader,
  type RegistryCommandDeps,
} from "./pilot.js";
import { assessLegacyHoldRoute, LEGACY_HOLD_GAP_CODES, type ActivationFences } from "./pilot-lifecycle.js";
import { readRegisteredRecord, type HoldRecord } from "./pilot-records.js";
import {
  createPilotFixture,
  ENGINE_PID,
  FIXTURE_RELEASE,
  WORKER_PID,
  type PilotFixture,
} from "./testing/pilot-fixture.js";
import { createProbeHarness, type ProbeHarness } from "./testing/pilot-probe-harness.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});

const clock = { now: Date.now, mono: () => performance.now() };

async function setup(layout: "legacy" | "packaged") {
  const f = await createPilotFixture({ layout });
  cleanups.push(f.base);
  f.writeDescriptor();
  const h = createProbeHarness(f);
  return { f, h };
}

function deps(f: PilotFixture, h: ProbeHarness, operationId: string, withProbes = true): RegistryCommandDeps {
  const reader: PilotServiceReader = {
    inspect: async (label) => f.inspection(label),
    listenerOwners: async () => [WORKER_PID],
    processCensus: async () => [],
  };
  return {
    instance: f.instance,
    controllerFor: () => reader,
    fetchImpl: (async (url: string | URL) =>
      String(url).endsWith("/worker")
        ? new Response(JSON.stringify({ agent_name: "hive-voice", active_jobs: 0 }), { status: 200 })
        : new Response("ok", { status: 200 })) as typeof fetch,
    settleBarrier: async (barrier) => {
      await writeOperationJson(resolve(barrier.operationDirectory, "barrier-release.json"), { outcome: "released" });
      return "released";
    },
    randomId: randomUUID,
    ...(withProbes
      ? {
          probes: {
            operationId,
            clock,
            io: h.io,
            randomId: randomUUID,
            readRelease: () => FIXTURE_RELEASE,
            request: (options) => h.request(options),
            wait: async () => {},
          },
        }
      : {}),
  };
}

describe("native capability through the registry provider", () => {
  it("the uninstrumented legacy pilot stays pending even with every probe boundary wired", async () => {
    const { f, h } = await setup("legacy");
    const operation = await f.registryOperation("prepare-legacy-hold");
    const result = await runPrepareLegacyHold(operation, f.snapshot.selector, deps(f, h, operation.record.id));
    expect(result.exitCode).toBe(1);
    expect(result.result).toMatchObject({ status: "MIGRATION_PENDING", gaps: [...LEGACY_HOLD_GAP_CODES] });
    expect(h.calls.some((call) => call.startsWith("close"))).toBe(false);
    expect(operation.record.registry!.barrier).toBeNull();
    await finishOperationLock(operation);
  });

  it("a capable historical layout is native-capable only with wired probes and current corroboration", async () => {
    const { f, h } = await setup("packaged");
    const operation = await f.registryOperation("inventory-pilot");
    const loaded = await loadRegisteredPilot(f.snapshot.selector, f.instance);
    expect(await currentHoldCapability(loaded, deps(f, h, operation.record.id, false))).toMatchObject({
      kind: "unavailable",
      gaps: ["NATIVE_HOLD_ADAPTER_UNAVAILABLE", ...LEGACY_HOLD_GAP_CODES],
    });
    expect(await currentHoldCapability(loaded, deps(f, h, operation.record.id))).toEqual({ kind: "native-capable" });
    f.writeDescriptor(f.descriptor({ bootId: randomUUID(), pid: 4444 }));
    expect(await currentHoldCapability(loaded, deps(f, h, operation.record.id))).toMatchObject({
      gaps: ["NATIVE_CAPABILITY_UNCORROBORATED", ...LEGACY_HOLD_GAP_CODES],
    });
    await finishOperationLock(operation);
  });

  it("prepare exercises close, registered closed readback and same-owner release; verify and release stay selectors", async () => {
    const { f, h } = await setup("packaged");
    const prepare = await f.registryOperation("prepare-legacy-hold");
    const prepared = await runPrepareLegacyHold(prepare, f.snapshot.selector, deps(f, h, prepare.record.id));
    expect(prepared.exitCode).toBe(0);
    expect(prepared.result.status).toBe("LEGACY_HOLD_EXERCISED_AND_RELEASED");
    expect(h.state).toMatchObject({ admission: "open", owner: null });
    const order = h.calls.filter((call) => /^(close|release)/.test(call));
    expect(order).toEqual(["close:closed", "release:open"]);
    expect(prepare.record.registry!.barrier).toMatchObject({ state: "released" });
    const hold = await readRegisteredRecord<HoldRecord>(String(prepared.result.holdRecord), {
      instance: f.instance,
      kind: "legacy-hold",
    });
    expect(hold.payload.procedure).toMatchObject({ kind: "hive-maintenance-v1", operationId: prepare.record.id });
    expect(hold.payload.gaps).toEqual([]);
    expect(hold.payload.sources.filter((source) => source.accounting === "admission-ledger")).toHaveLength(8);
    expect(
      hold.payload.sources.every((source) => source.accounting !== "admission-ledger" || source.scope === "unknown"),
    ).toBe(true);
    await finishOperationLock(prepare);

    const verify = await f.registryOperation("verify-legacy-hold");
    const verified = await runVerifyLegacyHold(
      verify,
      String(prepared.result.holdRecord),
      deps(f, h, verify.record.id),
    );
    expect(verified.result).toMatchObject({
      status: "NATIVE_HOLD_AVAILABLE",
      establishment: "requires-new-operation-close",
    });
    expect(h.calls.filter((call) => call.startsWith("close"))).toHaveLength(1);
    await finishOperationLock(verify);

    const release = await f.registryOperation("release-legacy-hold");
    const released = await runReleaseLegacyHold(
      release,
      String(prepared.result.holdRecord),
      deps(f, h, release.record.id),
    );
    expect(released.result.status).toBe("HOLD_RELEASED_VERIFIED");
    await finishOperationLock(release);
  });

  it("an interrupted native prepare with a committed hold reconciles only after settling its barrier", async () => {
    const { f, h } = await setup("packaged");
    const operation = await f.registryOperation("prepare-legacy-hold");
    const d = deps(f, h, operation.record.id);
    await runPrepareLegacyHold(operation, f.snapshot.selector, d);
    const state = operation.record.registry!;
    state.outcome = null;
    state.result = null;
    state.barrier!.state = "release-intended";
    let settled = 0;
    const reconciled = await reconcileRegistryWork(operation, {
      ...d,
      settleBarrier: async () => {
        settled += 1;
        return "released";
      },
    });
    expect(settled).toBe(1);
    expect(reconciled).toMatchObject({ outcome: "assessment-complete", barrier: "released" });
    await finishOperationLock(operation);
  });

  it("the lifecycle route establishes a fresh hold under its own operation through the provider", async () => {
    const { f, h } = await setup("packaged");
    const prepare = await f.registryOperation("prepare-legacy-hold");
    const prepared = await runPrepareLegacyHold(prepare, f.snapshot.selector, deps(f, h, prepare.record.id));
    await finishOperationLock(prepare);
    const update = await f.registryOperation("prepare-legacy-hold");
    const d = deps(f, h, update.record.id);
    const provider = registryPilotEvidence(d);
    const pilot = await assessLegacyHoldRoute({
      holdSelector: String(prepared.result.holdRecord),
      instance: f.instance,
      provider,
    });
    const intents: string[] = [];
    const session = await provider.establishHold(pilot, update, async ({ bootId }) => {
      intents.push(bootId);
      update.record.registry!.barrier = {
        operationId: update.record.id,
        supervisor: f.worker,
        bootId,
        descriptor: null,
        healthListenerPort: pilot.sdkListenerPort,
        state: "close-intended",
        terminalEvidence: null,
      };
      const { persistOperation } = await import("./operation.js");
      await persistOperation(update);
    });
    expect(intents).toEqual([f.descriptor().bootId]);
    expect(h.state.owner).toBe(update.record.id);
    await session.release();
    expect(h.state.owner).toBeNull();
    // A different operation cannot use these probe boundaries to establish a hold.
    await expect(provider.establishHold(pilot, prepare, async () => {})).rejects.toThrow(
      "NATIVE_HOLD_OPERATION_MISMATCH",
    );
    update.record.registry!.barrier!.state = "released";
    await finishOperationLock(update);
  });
});

describe("pilot inventory and recovery profile through the bootstrap probe", () => {
  it("records LiveKit observations as observations-only sources while every class keeps its gap", async () => {
    const { f, h } = await setup("legacy");
    const operation = await f.registryOperation("inventory-pilot");
    const result = await runInventoryPilot(operation, f.snapshot.selector, deps(f, h, operation.record.id));
    expect(h.calls).toContain("outer:pilot-inventory");
    expect(result.result.observedClasses).toEqual(
      expect.arrayContaining(["room-and-token-dispatch", "sip-dispatch-rules"]),
    );
    expect((result.result.gaps as { category: string }[]).map((gap) => gap.category)).toContain("sip-dispatch-rules");
    await finishOperationLock(operation);
  });

  it("the captured-loader bridge profile is authenticated only through a successful probe", async () => {
    const { f, h } = await setup("legacy");
    const operation = await f.registryOperation("inventory-pilot");
    const loaded = await loadRegisteredPilot(f.snapshot.selector, f.instance);
    const fence = { path: `${f.home}/missing.log`, dev: 0, ino: 0, offset: 0 };
    const fences: ActivationFences = {
      engineLog: fence,
      workerLog: fence,
      wallStartedAt: 0,
      stopped: { engine: null, worker: null },
    };
    const d = deps(f, h, operation.record.id);
    const ok = await observeRegisteredPilotRecovery(loaded, fences, d);
    expect(ok.bridge).toEqual({ authenticated: true, missingDenied: true, wrongDenied: true });
    h.state.bridgeAuthenticated = false;
    const denied = await observeRegisteredPilotRecovery(loaded, fences, d);
    expect(denied.bridge).toEqual({ authenticated: false, missingDenied: false, wrongDenied: false });
    expect(ENGINE_PID).toBeGreaterThan(0);
    await finishOperationLock(operation);
  });
});
