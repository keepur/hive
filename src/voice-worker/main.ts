import { defineAgent, cli, WorkerOptions, type JobContext } from "@livekit/agents";
import { MongoClient } from "mongodb";
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createLogger } from "../logging/logger.js";
import { resolveCell } from "./cells.js";
import { parseDispatchMetadata } from "./dispatch-meta.js";
import { runCallSession } from "./session.js";
import { VoiceWorkerHeartbeat } from "./telemetry.js";
import { livekitServerAuth, loadWorkerConfig } from "./worker-config.js";

const log = createLogger("voice-worker");

export type { DispatchMetadata } from "./dispatch-meta.js";
export { parseDispatchMetadata } from "./dispatch-meta.js";

export default defineAgent({
  entry: async (ctx: JobContext) => {
    const wc = loadWorkerConfig();
    const meta = parseDispatchMetadata(ctx.job.metadata);
    const cell = resolveCell(meta, wc);
    const mongo = new MongoClient(wc.mongoUri);
    await mongo.connect();
    const heartbeat = new VoiceWorkerHeartbeat(mongo.db(wc.mongoDbName).collection("telemetry"), {
      defaultStt: wc.defaultStt,
      defaultTts: wc.defaultTts,
    });
    // entry() returns while the LiveKit job is still running. Close Mongo
    // from the session's ordered shutdown callback (after noteCallEnded),
    // not as a sibling Promise.all callback — close must not race persist().
    await runCallSession(ctx, wc, meta, cell, heartbeat, () => mongo.close().catch(() => {}));
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
    const wc = loadWorkerConfig();
    // Forked job procs fall back to env when WorkerOptions aren't forwarded.
    // This process is the voice-worker, not a cloud-model agent — env is allowed.
    process.env.LIVEKIT_URL = wc.livekitUrl;
    process.env.LIVEKIT_API_KEY = wc.livekitApiKey;
    process.env.LIVEKIT_API_SECRET = wc.livekitApiSecret;
    const mongo = new MongoClient(wc.mongoUri);
    await mongo.connect();
    const workerHeartbeat = new VoiceWorkerHeartbeat(mongo.db(wc.mongoDbName).collection("telemetry"), {
      defaultStt: wc.defaultStt,
      defaultTts: wc.defaultTts,
    });
    await workerHeartbeat.writeBoot();
    workerHeartbeat.start();
    cli.runApp(
      new WorkerOptions({
        agent: fileURLToPath(import.meta.url),
        agentName: "hive-voice",
        ...livekitServerAuth(wc),
      }),
    );
  })().catch((err) => {
    log.error("voice worker boot failed", { error: String(err) });
    process.exit(1);
  });
}
