import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createMaintenanceSupervisor } from "./maintenance-ipc.js";

const mocks = vi.hoisted(() => ({
  loadWorkerConfig: vi.fn(),
  runCallSession: vi.fn(),
  connect: vi.fn(),
  close: vi.fn(),
  db: vi.fn(() => ({ collection: vi.fn(() => ({})) })),
  MongoClient: vi.fn(),
}));

vi.mock("./worker-config.js", () => ({
  loadWorkerConfig: mocks.loadWorkerConfig,
  livekitServerAuth: vi.fn(() => ({ wsURL: "wss://fixture", apiKey: "key", apiSecret: "secret" })),
}));
vi.mock("./session.js", () => ({ runCallSession: mocks.runCallSession }));
vi.mock("./telemetry.js", () => ({
  VoiceWorkerHeartbeat: class VoiceWorkerHeartbeat {
    static readonly INTERVAL_MS = 30_000;
    writeBoot = vi.fn();
    start = vi.fn();
    stop = vi.fn();
  },
}));
vi.mock("mongodb", () => ({
  MongoClient: mocks.MongoClient.mockImplementation(function MongoClient() {
    return { connect: mocks.connect, close: mocks.close, db: mocks.db };
  }),
}));

import voiceAgent, { isEntrypoint } from "./main.js";

const WORKER_CONFIG = {
  instanceHome: "/fixture/hive",
  instanceId: "fixture",
  healthPort: 4107,
  livekitUrl: "wss://fixture",
  livekitApiKey: "key",
  livekitApiSecret: "secret",
  sipTrunkId: "ST_fixture",
  inboundAgents: {},
  agentVoices: {},
  defaultStt: "deepgram/flux-general-en",
  defaultTts: "cartesia/sonic-3",
  deepgramApiKey: "deepgram",
  cartesiaApiKey: "cartesia",
  elevenlabsApiKey: "elevenlabs",
  bridgeToken: "bridge",
  bridgeUrl: "http://127.0.0.1:4105/v1/chat/completions",
  mongoUri: "mongodb://fixture",
  mongoDbName: "fixture",
};

// Node resolves a module's `import.meta.url` through the real filesystem
// path (symlinks included) at load time — so the accurate way to simulate
// "the module was loaded from path P" is to build the URL from P's realpath,
// not from P verbatim. This also sidesteps macOS's own `/var` → `/private/var`
// symlink on tmpdir() paths, which would otherwise make direct string
// comparisons flaky independent of the behavior under test.
function moduleUrlFor(path: string): string {
  return pathToFileURL(realpathSync(path)).href;
}

// KPR-428 — the launchd-entrypoint "am I the main module" guard must resolve
// through symlinks (Node resolves `import.meta.url` through the real
// filesystem path, but `process.argv[1]` stays as typed). A regression here
// makes the voice worker silently no-op boot: exit 0, no error, and launchd's
// `KeepAlive.SuccessfulExit: false` never restarts it.
describe("isEntrypoint (KPR-428)", () => {
  let tmp: string;

  beforeEach(() => {
    // realpathSync up front: on macOS, tmpdir() paths live under `/var`,
    // itself a symlink to `/private/var` — without this, `tmp` (and every
    // path built from it) is not its own realpath, so the "direct
    // invocation" case below would silently fall through to the realpath
    // fallback branch instead of exercising the fast path it's named for.
    tmp = realpathSync(mkdtempSync(join(tmpdir(), "voice-worker-entrypoint-test-")));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it("returns false when argv[1] is undefined (imported, not executed)", () => {
    expect(isEntrypoint(undefined, import.meta.url)).toBe(false);
  });

  it("returns false when argv[1] names a different module (imported from a test/caller)", () => {
    const real = join(tmp, "real.ts");
    writeFileSync(real, "");
    const other = join(tmp, "other.ts");
    writeFileSync(other, "");
    expect(isEntrypoint(other, moduleUrlFor(real))).toBe(false);
  });

  it("returns true on direct invocation (argv[1] === the real module path)", () => {
    const real = join(tmp, "real.ts");
    writeFileSync(real, "");
    expect(isEntrypoint(real, moduleUrlFor(real))).toBe(true);
  });

  it("returns true on direct invocation when the path needs percent-encoding (a space in a directory name)", () => {
    const spaceDir = join(tmp, "space dir");
    mkdirSync(spaceDir);
    const real = join(spaceDir, "real.ts");
    writeFileSync(real, "");
    expect(isEntrypoint(real, moduleUrlFor(real))).toBe(true);
  });

  it("returns true via the direct URL comparison alone, before ever touching the filesystem", () => {
    // A nonexistent argv[1] denies the realpath fallback its rescue (it
    // throws ENOENT and the catch returns false) — so this only passes if
    // the fast-path pathToFileURL comparison itself is correct, isolating
    // it from the fallback branch the other cases above can't discriminate.
    const ghost = join(tmp, "space dir", "never-created.ts");
    expect(isEntrypoint(ghost, pathToFileURL(ghost).href)).toBe(true);
  });

  it("returns true when argv[1] is a symlink to the real module path (the KPR-428 regression case)", () => {
    const real = join(tmp, "real.ts");
    writeFileSync(real, "");
    const link = join(tmp, "linked.ts");
    symlinkSync(real, link);

    // import.meta.url for a module loaded via a symlinked argv[1] resolves
    // through to the real path — this is what Node actually does, and is
    // reproduced here directly rather than mocked. argv[1] itself stays as
    // the symlinked path, exactly as launchd/tsx would invoke it.
    expect(isEntrypoint(link, moduleUrlFor(real))).toBe(true);
  });

  it("returns false when a symlinked argv[1] does not resolve to the module path", () => {
    const real = join(tmp, "real.ts");
    writeFileSync(real, "");
    const unrelated = join(tmp, "unrelated.ts");
    writeFileSync(unrelated, "");
    const link = join(tmp, "linked.ts");
    symlinkSync(unrelated, link);

    expect(isEntrypoint(link, moduleUrlFor(real))).toBe(false);
  });

  it("returns false when argv[1] points at a nonexistent path (realpath fallback fails closed)", () => {
    const real = join(tmp, "real.ts");
    writeFileSync(real, "");
    const missing = join(tmp, "does-not-exist.ts");
    expect(isEntrypoint(missing, moduleUrlFor(real))).toBe(false);
  });
});

describe("tracked default agent entry (KPR-463)", () => {
  const trackingKeys = ["HIVE_VOICE_SUPERVISOR_PID", "HIVE_VOICE_SUPERVISOR_BOOT_ID", "HIVE_VOICE_STATE_DIR"] as const;
  let savedEnvironment: Array<[string, string | undefined]>;
  let home: string;

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.loadWorkerConfig.mockReturnValue(WORKER_CONFIG);
    mocks.connect.mockResolvedValue(undefined);
    mocks.close.mockResolvedValue(undefined);
    mocks.runCallSession.mockResolvedValue(undefined);
    savedEnvironment = trackingKeys.map((key) => [key, process.env[key]]);
    home = realpathSync(mkdtempSync(join(tmpdir(), "voice-worker-tracked-entry-")));
  });

  afterEach(() => {
    for (const [key, value] of savedEnvironment) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(home, { recursive: true, force: true });
  });

  async function harness(metadata = "{}") {
    const supervisorRef = { pid: 700, bootId: "11111111-1111-4111-8111-111111111111" };
    const supervisor = createMaintenanceSupervisor({
      instanceHome: home,
      instanceId: "fixture",
      supervisor: supervisorRef,
      bootedAt: 1,
      sdkHost: "127.0.0.1",
      sdkPort: 4107,
    });
    await supervisor.ledger.request({ id: "job-a", accept: async () => {}, reject: async () => {} });
    process.env.HIVE_VOICE_SUPERVISOR_PID = String(supervisorRef.pid);
    process.env.HIVE_VOICE_SUPERVISOR_BOOT_ID = supervisorRef.bootId;
    process.env.HIVE_VOICE_STATE_DIR = supervisor.stateDirectory;
    let shutdown!: () => Promise<void>;
    const ctx = {
      job: { id: "job-a", metadata },
      addShutdownCallback(callback: () => Promise<void>) {
        shutdown = callback;
      },
    };
    return { supervisor, ctx, shutdown: () => shutdown() };
  }

  it("imports the compiled production agent without starting the supervisor or loading config", () => {
    const scratch = realpathSync(mkdtempSync(join(tmpdir(), "voice-worker-import-")));
    try {
      const compiled = pathToFileURL(join(import.meta.dirname, "../../dist/voice-worker/main.js")).href;
      const result = spawnSync(
        process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(compiled)}); process.stdout.write("IMPORTED\\n")`],
        {
          cwd: scratch,
          env: { HOME: scratch, PATH: process.env.PATH ?? "", NODE_ENV: "test" },
          encoding: "utf8",
        },
      );
      expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({
        status: 0,
        stdout: "IMPORTED\n",
        stderr: "",
      });
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it("reports pre-config failure only after SDK shutdown", async () => {
    const h = await harness();
    mocks.loadWorkerConfig.mockImplementation(() => {
      throw new Error("configuration failed");
    });

    await expect(voiceAgent.entry(h.ctx as never)).rejects.toThrow("configuration failed");
    await h.supervisor.pollOnce();
    expect(h.supervisor.ledger.snapshot().unresolved).toMatchObject([
      { jobId: "job-a", phase: "entered-awaiting-completion", childPid: process.pid },
    ]);

    await h.shutdown();
    await h.supervisor.pollOnce();
    expect(h.supervisor.ledger.snapshot().unresolved).toEqual([]);
  });

  it("does not construct Mongo when metadata-derived cell validation fails", async () => {
    const h = await harness('{"stt":"deepgram/unknown"}');

    await expect(voiceAgent.entry(h.ctx as never)).rejects.toThrow("Unknown STT cell");

    expect(mocks.MongoClient).not.toHaveBeenCalled();
    await h.shutdown();
  });

  it("closes Mongo only on shutdown after a connect failure", async () => {
    const h = await harness();
    mocks.connect.mockRejectedValue(new Error("mongo unavailable"));

    await expect(voiceAgent.entry(h.ctx as never)).rejects.toThrow("mongo unavailable");
    expect(mocks.close).not.toHaveBeenCalled();

    await h.shutdown();
    expect(mocks.close).toHaveBeenCalledOnce();
  });

  it("waits for the session's ordered Mongo cleanup before reporting completion", async () => {
    const h = await harness();
    let orderedCleanup!: () => Promise<void>;
    mocks.runCallSession.mockImplementation(async (...args: unknown[]) => {
      orderedCleanup = args[5] as () => Promise<void>;
    });

    await voiceAgent.entry(h.ctx as never);
    await h.supervisor.pollOnce();
    let shutdownSettled = false;
    const shutdown = h.shutdown().then(() => {
      shutdownSettled = true;
    });
    await Promise.resolve();

    expect(shutdownSettled).toBe(false);
    expect(mocks.close).not.toHaveBeenCalled();
    expect(h.supervisor.ledger.snapshot().unresolved).toHaveLength(1);

    await orderedCleanup();
    await shutdown;
    await h.supervisor.pollOnce();
    expect(mocks.close).toHaveBeenCalledOnce();
    expect(h.supervisor.ledger.snapshot().unresolved).toEqual([]);
  });
});
