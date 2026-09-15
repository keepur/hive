import { afterEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { finishOperationLock, type AcquiredOperation } from "./operation.js";
import { captureTicketValidator, reconcileRegistryWork, type RegistryCommandDeps } from "./pilot.js";
import {
  bridgePortFor,
  dotenvPathFor,
  PilotCaptureBlockedError,
  runCapturePilot,
  type CaptureDeps,
} from "./pilot-capture.js";
import { pilotConfigIdentity } from "./pilot-probe.js";
import { readRegisteredRecord, sealFile, type PilotSnapshot } from "./pilot-records.js";
import type { CaptureDiscovery, CaptureFileSeal } from "./services.js";
import {
  BRIDGE_PORT,
  createPilotFixture,
  ENGINE_PID,
  FIXTURE_RELEASE,
  FIXTURE_START,
  SDK_PORT,
  WORKER_PID,
  writeFixtureFile,
  type PilotFixture,
} from "./testing/pilot-fixture.js";
import { createProbeHarness, type ProbeHarness } from "./testing/pilot-probe-harness.js";

const cleanups: string[] = [];
afterEach(async () => {
  for (const path of cleanups.splice(0)) await rm(path, { recursive: true, force: true });
});

const clock = { now: Date.now, mono: () => performance.now() };

async function captureSeal(path: string): Promise<CaptureFileSeal> {
  return sealFile(path, { uid: process.getuid!(), allowRoot: true });
}

interface Setup {
  f: PilotFixture;
  h: ProbeHarness;
  operation: AcquiredOperation;
  deps: CaptureDeps;
  discoveries: number;
  mutate: { secondStart?: string; listeners?: number[]; writers?: Record<string, number[]> };
}

async function setup(layout: "legacy" | "packaged" = "legacy"): Promise<Setup> {
  const f = await createPilotFixture({ layout, admission: "unavailable" });
  cleanups.push(f.base);
  f.writeDescriptor();
  writeFileSync(f.instance.configPath, `instance:\n  id: dodi\n  ports:\n    voice: ${BRIDGE_PORT}\n`, { mode: 0o644 });
  const h = createProbeHarness(f);
  const operation = await f.registryOperation("capture-pilot");
  const nowIso = new Date().toISOString();
  writeFixtureFile(
    f.definitions.engine.stdout,
    `${JSON.stringify({ ts: nowIso, msg: "Hive starting up" })}\n${JSON.stringify({ ts: nowIso, msg: "Hive is running" })}\n`,
  );
  writeFixtureFile(f.definitions.worker.stdout, `${JSON.stringify({ ts: nowIso, msg: "registered worker" })}\n`);
  for (const [label, target] of [
    [f.definitions.engine.label, resolve(f.base, "launch/engine.plist")],
    [f.definitions.worker.label, resolve(f.base, "launch/worker.plist")],
  ] as const) {
    symlinkSync(target, resolve(f.userHome, "Library/LaunchAgents", `${label}.plist`));
  }
  const s = { f, h, operation, discoveries: 0, mutate: {} } as Setup;
  const ticketDeps = { isProcessLive: async () => true };
  const validate = captureTicketValidator(ticketDeps);
  const found = async (component: "engine" | "worker"): Promise<CaptureDiscovery> => {
    const definition = component === "engine" ? f.definitions.engine : f.definitions.worker;
    const process = component === "engine" ? f.engine : f.worker;
    const effective = resolve(f.base, `launch/${component}.plist`);
    const link = resolve(f.userHome, "Library/LaunchAgents", `${definition.label}.plist`);
    const second = s.discoveries > 2 && component === "worker" && s.mutate.secondStart;
    return {
      label: definition.label,
      enabled: true,
      process: { ...process, ppid: 1, startTime: second ? s.mutate.secondStart! : process.startTime },
      args: [definition.nodePath, definition.entrypoint, ...definition.args],
      cwd: f.home,
      configSelection: definition.configPath,
      serviceEnvironment: {
        HIVE_HOME: definition.hiveHome,
        HIVE_CONFIG: definition.configPath,
        HOME: definition.home,
        PATH: definition.pathEnv,
      },
      stdout: definition.stdout,
      stderr: definition.stderr,
      link: {
        path: link,
        target: effective,
        resolvedTarget: effective,
        dev: statSync(link, { bigint: false }).dev,
        ino: 1,
      },
      effectivePlist: await captureSeal(effective),
      instancePlist: { path: resolve(f.home, "service", `${definition.label}.plist`), existed: false, seal: null },
    };
  };
  s.deps = {
    instance: f.instance,
    isProcessLive: ticketDeps.isProcessLive,
    discovery: {
      async discoverForCapture(ticket) {
        await validate(ticket);
        s.discoveries += 2;
        return [await found("engine"), await found("worker")];
      },
      listenersOf: async () => s.mutate.listeners ?? [SDK_PORT],
      listenerOwners: async (port) => (port === SDK_PORT ? [WORKER_PID] : port === BRIDGE_PORT ? [ENGINE_PID] : []),
      processUid: async () => process.getuid!(),
      fileWriters: async (path) =>
        s.mutate.writers?.[path] ?? (path === f.definitions.engine.stdout ? [ENGINE_PID] : [WORKER_PID]),
    },
    probes: { operationId: operation.record.id, clock, io: h.io, randomId: randomUUID },
    fetchImpl: (async (url: string | URL) =>
      String(url).includes(`:${SDK_PORT}/`)
        ? String(url).endsWith("/worker")
          ? new Response(JSON.stringify({ agent_name: "hive-voice", active_jobs: 0 }), { status: 200 })
          : new Response("ok", { status: 200 })
        : new Response("no", { status: 404 })) as typeof fetch,
    now: Date.now,
    randomId: randomUUID,
  };
  return s;
}

describe("first pilot capture", () => {
  it("captures the legacy pilot from an empty snapshot registry through the draft subject and registers last", async () => {
    const s = await setup();
    const external = resolve(s.f.base, "launch/worker.plist");
    const before = { bytes: readFileSync(external), mtime: statSync(external).mtimeMs };
    const result = await runCapturePilot(s.operation, s.f.bootstrap.selector, s.deps);
    expect(result.exitCode).toBe(0);
    expect(result.result).toMatchObject({
      status: "PILOT_SNAPSHOT_REGISTERED",
      loader: "legacy-module",
      admission: "unavailable",
    });
    expect(s.h.calls).toEqual(["outer:pilot"]);
    const state = s.operation.record.registry!;
    expect(state.capture).toMatchObject({ phase: "committed" });
    expect(state.outcome).toBe("record-committed");

    const snapshot = await readRegisteredRecord<PilotSnapshot>(String(result.result.snapshot), {
      instance: s.f.instance,
      kind: "pilot-snapshot",
    });
    expect(snapshot.reference.id).toBe(state.capture!.snapshotId);
    expect(snapshot.payload.configIdentity).toBe(
      pilotConfigIdentity(s.f.loaderConfig as never, s.f.instance, SDK_PORT),
    );
    expect(snapshot.payload.runtime.sdkListener.port).toBe(SDK_PORT);
    expect(snapshot.payload.runtime.bridgePort).toBe(BRIDGE_PORT);
    expect(snapshot.payload.admission).toEqual({ kind: "unavailable" });
    // Backups and manifests were re-sealed under the registry entry; sources stayed external and untouched.
    for (const save of snapshot.payload.services) {
      expect(save.effectivePlist.saved.path.startsWith(snapshot.filesDirectory)).toBe(true);
    }
    expect(snapshot.payload.runtime.roots.every((root) => root.manifest.path.startsWith(snapshot.filesDirectory))).toBe(
      true,
    );
    expect(snapshot.payload.configFiles.map((file) => file.path)).toEqual([
      s.f.instance.configPath,
      dotenvPathFor(s.f.home, s.f.instance.configPath),
    ]);
    expect(readFileSync(external).equals(before.bytes)).toBe(true);
    expect(statSync(external).mtimeMs).toBe(before.mtime);
    // The draft is never a selectable registry record.
    const draftPath = resolve(s.operation.paths.operationDirectory, "capture/draft.json");
    await expect(readRegisteredRecord(draftPath, { instance: s.f.instance, kind: "pilot-snapshot" })).rejects.toThrow();
    const text = readFileSync(String(result.result.snapshot), "utf8");
    expect(text).not.toContain("dummy-bridge-token");
    await finishOperationLock(s.operation);
  });

  it("a process change during capture, an unattributable log or a failed profile registers nothing", async () => {
    for (const variant of ["unstable", "logs", "bridge", "ambiguous"] as const) {
      const s = await setup();
      if (variant === "unstable") s.mutate.secondStart = "Mon Sep 14 11:11:11 2026";
      if (variant === "logs") s.mutate.writers = { [s.f.definitions.worker.stdout]: [WORKER_PID, 4242] };
      if (variant === "bridge") s.h.state.bridgeAuthenticated = false;
      if (variant === "ambiguous") {
        s.mutate.listeners = [SDK_PORT, SDK_PORT + 1];
        s.deps.fetchImpl = (async (url: string | URL) =>
          String(url).endsWith("/worker")
            ? new Response(JSON.stringify({ agent_name: "hive-voice", active_jobs: 0 }), { status: 200 })
            : new Response("ok", { status: 200 })) as typeof fetch;
      }
      const error = await runCapturePilot(s.operation, s.f.bootstrap.selector, s.deps).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(PilotCaptureBlockedError);
      expect((error as PilotCaptureBlockedError).reason).toBe(
        {
          unstable: "CAPTURE_UNSTABLE",
          logs: "CAPTURE_LOGS_UNATTRIBUTABLE",
          bridge: "PILOT_BRIDGE_FAILED",
          ambiguous: "SDK_LISTENER_AMBIGUOUS",
        }[variant],
      );
      const registrations = (s.operation.record.registrations ?? []).filter((fence) => fence.state === "committed");
      expect(registrations).toEqual([]);
      // Crash-style reconciliation keeps the uncommitted capture aborted and nonselectable.
      const reconciled = await reconcileRegistryWork(s.operation, {
        instance: s.f.instance,
        settleBarrier: async () => {
          throw new Error("capture never owns a barrier");
        },
      } as Pick<RegistryCommandDeps, "instance" | "settleBarrier">);
      expect(reconciled).toMatchObject({ outcome: "aborted", registration: null });
      await finishOperationLock(s.operation);
    }
  });

  it("captures a packaged historical layout and records native admission only from current runtime evidence", async () => {
    const s = await setup("packaged");
    s.deps.readRelease = () => FIXTURE_RELEASE;
    const result = await runCapturePilot(s.operation, s.f.bootstrap.selector, s.deps);
    expect(result.result).toMatchObject({ loader: "packaged-probe", admission: "hive-maintenance-v1" });
    expect(s.h.calls).toEqual(["outer:pilot", "historical:pilot-abi", "historical:pilot-abi-v1"]);
    await finishOperationLock(s.operation);

    const stale = await setup("packaged");
    stale.deps.readRelease = () => FIXTURE_RELEASE;
    stale.f.writeDescriptor(stale.f.descriptor({ pid: 9999 }));
    const other = await runCapturePilot(stale.operation, stale.f.bootstrap.selector, stale.deps);
    expect(other.result).toMatchObject({ loader: "packaged-probe", admission: "unavailable" });
    await finishOperationLock(stale.operation);
  });

  it("an inventoried --pilot-sdk-port resolves multiple listeners only when corroborated", async () => {
    const s = await setup();
    s.mutate.listeners = [SDK_PORT, 9999];
    s.deps.pilotSdkPort = 9999;
    await expect(runCapturePilot(s.operation, s.f.bootstrap.selector, s.deps)).rejects.toMatchObject({
      reason: "PILOT_SDK_PORT_UNCORROBORATED",
    });
    await finishOperationLock(s.operation).catch(() => {});
  });

  it("derives the bridge port from the selected configuration and the dotenv selector from the config name", () => {
    expect(bridgePortFor("instance:\n  portBase: 4000\n", {})).toBe(4005);
    expect(bridgePortFor("instance:\n  ports:\n    voice: 4107\n", {})).toBe(4107);
    expect(bridgePortFor("instance:\n  id: x\n", { VOICE_PORT: "5107" })).toBe(5107);
    expect(dotenvPathFor("/h", "/h/hive-personal.yaml")).toBe("/h/.env-personal");
    expect(dotenvPathFor("/h", "/h/hive.yaml")).toBe("/h/.env");
    expect(FIXTURE_START).toBeTruthy();
  });
});
