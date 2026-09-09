import { defineAgent, cli, WorkerOptions, type JobContext } from "@livekit/agents";
import { MongoClient } from "mongodb";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { bootIdentityForModule, bootIdentityLogFields, packageRootForModule } from "../deployment/release.js";
import { createLogger } from "../logging/logger.js";
import { resolveCell } from "./cells.js";
import { parseDispatchMetadata } from "./dispatch-meta.js";
import { withJobLifecycle } from "./job-lifecycle.js";
import { createJobReporter, createMaintenanceSupervisor } from "./maintenance-ipc.js";

const log = createLogger("voice-worker");

export type { DispatchMetadata } from "./dispatch-meta.js";
export { parseDispatchMetadata } from "./dispatch-meta.js";

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const trackingKeys = ["HIVE_VOICE_SUPERVISOR_PID", "HIVE_VOICE_SUPERVISOR_BOOT_ID", "HIVE_VOICE_STATE_DIR"];
    const hasTrackingEnvironment = trackingKeys.some((key) => process.env[key] !== undefined);
    const reporter =
      hasTrackingEnvironment || packageRootForModule(import.meta.url, "voice-worker") !== null
        ? createJobReporter({ jobId: ctx.job.id })
        : {
            entered() {},
            completed() {},
          };
    await withJobLifecycle(ctx, reporter, async (hooks) => {
      const { loadWorkerConfig } = await import("./worker-config.js");
      const { runCallSession } = await import("./session.js");
      const { VoiceWorkerHeartbeat } = await import("./telemetry.js");
      const wc = loadWorkerConfig();
      const meta = parseDispatchMetadata(ctx.job.metadata);
      const cell = resolveCell(meta, wc);
      const mongo = new MongoClient(wc.mongoUri);
      hooks.setEarlyCleanup(() => mongo.close());
      await mongo.connect();
      const heartbeat = new VoiceWorkerHeartbeat(mongo.db(wc.mongoDbName).collection("telemetry"), {
        defaultStt: wc.defaultStt,
        defaultTts: wc.defaultTts,
      });
      const cleanupFinished = hooks.delegateCleanup();
      await runCallSession(ctx, wc, meta, cell, heartbeat, async () => {
        await mongo.close();
        cleanupFinished();
      });
    });
  },
});

/**
 * Launchd-entrypoint "am I the main module" check.
 *
 * A raw `argv[1] === fileURLToPath(import.meta.url)` comparison silently
 * fails when the invocation path is reached through a symlink: node resolves
 * `import.meta.url` through the real filesystem path, but `argv[1]` stays as
 * typed. If a deploy checkout is symlinked, the guard never matches, boot
 * (loadWorkerConfig/Mongo connect/cli.runApp) never runs, and the process
 * exits 0 — which launchd's `KeepAlive.SuccessfulExit: false` treats as
 * success and does not restart. Same idiom, same fix as
 * `scripts/flatten-skills.ts`'s `isMain()`: try a direct URL comparison
 * first (also covers argv[1] paths needing percent-encoding), then fall back
 * to comparing realpaths so a symlinked argv[1] still matches.
 *
 * Exported (params rather than reading `process.argv`/`import.meta.url`
 * directly) so tests can exercise the symlink fallback in isolation.
 */
export function isEntrypoint(argv1: string | undefined, moduleUrl: string): boolean {
  if (argv1 === undefined) return false;
  if (moduleUrl === pathToFileURL(argv1).href) return true;
  try {
    return fileURLToPath(moduleUrl) === realpathSync(argv1);
  } catch {
    return false;
  }
}

if (isEntrypoint(process.argv[1], import.meta.url)) {
  void (async () => {
    const [{ livekitServerAuth, loadWorkerConfig }, { VoiceWorkerHeartbeat }, { ServiceController }] =
      await Promise.all([import("./worker-config.js"), import("./telemetry.js"), import("../deployment/services.js")]);
    const wc = loadWorkerConfig();
    const identity = bootIdentityForModule(import.meta.url, "voice-worker");
    const supervisorRef = { pid: identity.pid, bootId: identity.bootId };
    const processInspector = new ServiceController({
      instanceId: wc.instanceId,
      hiveHome: wc.instanceHome,
      home: process.env.HOME ?? wc.instanceHome,
      operationDir: resolve(wc.instanceHome, ".hive-state", "deployment", "operations", identity.bootId),
    });
    const mailbox = createMaintenanceSupervisor({
      instanceHome: wc.instanceHome,
      instanceId: wc.instanceId,
      supervisor: supervisorRef,
      bootedAt: Date.parse(identity.startedAt),
      sdkHost: "127.0.0.1",
      sdkPort: wc.healthPort,
      inspectChildPids: async (pids) => {
        const observations = new Map<number, "absent" | "present" | "unknown">();
        await Promise.all(
          pids.map(async (pid) => {
            try {
              observations.set(pid, (await processInspector.process(pid)) === null ? "absent" : "present");
            } catch {
              observations.set(pid, "unknown");
            }
          }),
        );
        return observations;
      },
    });
    process.env.HIVE_VOICE_SUPERVISOR_PID = String(supervisorRef.pid);
    process.env.HIVE_VOICE_SUPERVISOR_BOOT_ID = supervisorRef.bootId;
    process.env.HIVE_VOICE_STATE_DIR = mailbox.stateDirectory;
    // Forked job procs fall back to env when WorkerOptions aren't forwarded.
    // This process is the voice-worker, not a cloud-model agent — env is allowed.
    process.env.LIVEKIT_URL = wc.livekitUrl;
    process.env.LIVEKIT_API_KEY = wc.livekitApiKey;
    process.env.LIVEKIT_API_SECRET = wc.livekitApiSecret;
    const mongo = new MongoClient(wc.mongoUri);
    const workerHeartbeat = new VoiceWorkerHeartbeat(
      mongo.db(wc.mongoDbName).collection("telemetry"),
      { defaultStt: wc.defaultStt, defaultTts: wc.defaultTts },
      VoiceWorkerHeartbeat.INTERVAL_MS,
      identity,
    );
    process.once("exit", () => {
      mailbox.stop();
      workerHeartbeat.stop();
      void mongo.close();
    });
    await mongo.connect();
    log.info("voice worker release boot", bootIdentityLogFields(identity));
    await workerHeartbeat.writeBoot();
    workerHeartbeat.start();
    mailbox.start();
    cli.runApp(
      new WorkerOptions({
        agent: fileURLToPath(import.meta.url),
        agentName: "hive-voice",
        host: "127.0.0.1",
        port: wc.healthPort,
        requestFunc: (request) => mailbox.ledger.request(request),
        ...livekitServerAuth(wc),
      }),
    );
  })().catch((err) => {
    log.error("voice worker boot failed", { error: String(err) });
    process.exit(1);
  });
}
