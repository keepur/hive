#!/usr/bin/env node
/**
 * Test-owned engine/worker stand-in for S9. Speaks production mailbox,
 * boot-identity, engine log markers, worker HTTP, bridge 400, and Mongo
 * voice_worker_stats heartbeat. Never a production entrypoint.
 */
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const require = createRequire(import.meta.url);
const control = process.env.HIVE_S9_CONTROL;
const repoRoot = process.env.HIVE_S9_REPO;
if (!control || !repoRoot) throw new Error("S9 stand-in requires HIVE_S9_CONTROL and HIVE_S9_REPO");

const dist = join(repoRoot, "dist");
const { createMaintenanceSupervisor, nodeMailboxFileSystem } = await import(
  pathToFileURL(join(dist, "voice-worker/maintenance-ipc.js")).href
);
const { readRelease, writeBootIdentityRecord, bootIdentity } = await import(
  pathToFileURL(join(dist, "deployment/release.js")).href
);
const { MongoClient } = await import("mongodb");

function arg(name) {
  const prefix = `--${name}=`;
  return process.argv.find((value) => value.startsWith(prefix))?.slice(prefix.length);
}

const role = arg("role") ?? process.env.HIVE_S9_ROLE ?? "engine";
const hiveHome = process.env.HIVE_HOME;
const configPath = process.env.HIVE_CONFIG;
if (!hiveHome || !configPath) throw new Error("stand-in requires HIVE_HOME and HIVE_CONFIG");

const yaml = parseYaml(readFileSync(configPath, "utf8"));
const instanceId = yaml?.instance?.id ?? "s9a";
const portBase = Number(yaml?.instance?.portBase ?? 3100);
const voicePort = Number(process.env.VOICE_PORT ?? process.env.HIVE_S9_VOICE_PORT ?? portBase + 5);
const workerPort = Number(process.env.HIVE_S9_WORKER_PORT ?? portBase + 7);
const mongoUri = process.env.HIVE_S9_MONGO_URI || process.env.MONGODB_URI || "mongodb://127.0.0.1:27017";
const mongoDb = process.env.HIVE_S9_MONGO_DB || process.env.MONGODB_DB || `hive_${instanceId}`;
const bridgeToken = process.env.HIVE_S9_BRIDGE_TOKEN || process.env.HIVE_VOICE_BRIDGE_TOKEN || "s9-bridge-token";

const hiveRoot = resolve(hiveHome, ".hive");
const release = readRelease(hiveRoot);
const identity = bootIdentity(release, role === "worker" ? "voice-worker" : "engine");
const recordPath = resolve(
  hiveHome,
  ".hive-state",
  "runtime",
  role === "worker" ? "voice-worker.json" : "engine.json",
);

const logPath = resolve(hiveHome, "logs", role === "worker" ? "voice-worker.log" : "hive.log");
mkdirSync(dirname(logPath), { recursive: true, mode: 0o755 });
function logLine(msg) {
  const line = `${JSON.stringify({ msg, pid: identity.pid, bootId: identity.bootId, ts: new Date().toISOString() })}\n`;
  require("fs").appendFileSync(logPath, line);
}

if (role === "engine") {
  logLine("Hive starting up");
  logLine("Hive is running");
  const server = createServer((req, res) => {
    if (req.method === "POST" && (req.url === "/v1/chat/completions" || req.url?.startsWith("/v1/chat/completions"))) {
      const auth = req.headers.authorization ?? "";
      if (!auth) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      if (auth !== `Bearer ${bridgeToken}`) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end("{}");
        return;
      }
      res.writeHead(400, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "call.metadata.hive_agent_id required" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    server.listen(voicePort, "127.0.0.1", () => resolvePromise());
    server.on("error", rejectPromise);
  });
  writeBootIdentityRecord(recordPath, identity);
}

if (role === "worker") {
  const delayClose = process.env.HIVE_S9_DELAY_CLOSE === "1";
  let releaseSeen = false;
  const fileSystem = delayClose
    ? {
        ...nodeMailboxFileSystem,
        readdirSync(path) {
          const names = nodeMailboxFileSystem.readdirSync(path);
          if (!String(path).endsWith(`${require("path").sep}commands`) && !String(path).endsWith("/commands")) {
            return names;
          }
          const receiptsDir = join(dirname(path), "command-receipts");
          let hadRelease = releaseSeen;
          try {
            for (const name of nodeMailboxFileSystem.readdirSync(receiptsDir)) {
              const raw = JSON.parse(readFileSync(join(receiptsDir, name), "utf8"));
              if (raw?.command?.kind === "release") hadRelease = true;
            }
          } catch {
            // receipts dir may not exist yet
          }
          if (hadRelease) {
            releaseSeen = true;
            return names.filter((name) => {
              try {
                const command = JSON.parse(readFileSync(join(path, name), "utf8"));
                return command.kind !== "close";
              } catch {
                return true;
              }
            });
          }
          return names;
        },
      }
    : nodeMailboxFileSystem;

  const supervisor = createMaintenanceSupervisor({
    instanceHome: hiveHome,
    instanceId,
    supervisor: { pid: identity.pid, bootId: identity.bootId },
    bootedAt: Date.now(),
    sdkHost: "127.0.0.1",
    sdkPort: workerPort,
    fileSystem,
  });
  supervisor.start();

  const admission = process.env.HIVE_S9_ADMISSION ?? "open";
  if (admission === "closed" || admission === "faulted") {
    const { requestMaintenance } = await import(
      pathToFileURL(join(dist, "voice-worker/maintenance-ipc.js")).href
    );
    const op = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    try {
      await requestMaintenance({
        instanceHome: hiveHome,
        instanceId,
        operationId: op,
        kind: "close",
        expectedAdmission: "closed",
        deadline: Date.now() + 5_000,
        supervisor: { pid: identity.pid, bootId: identity.bootId },
        corroborateSupervisor: async () => ({ pid: identity.pid, bootId: identity.bootId }),
      });
    } catch {
      // closed-gate tests still observe the snapshot
    }
  }

  const http = createServer((req, res) => {
    if (req.url === "/" || req.url === "") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/worker") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ agent_name: "hive-voice", active_jobs: 0 }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolvePromise, rejectPromise) => {
    http.listen(workerPort, "127.0.0.1", () => resolvePromise());
    http.on("error", rejectPromise);
  });

  const mongo = new MongoClient(mongoUri, { serverSelectionTimeoutMS: 5_000 });
  await mongo.connect();
  const telemetry = mongo.db(mongoDb).collection("telemetry");
  const writeHeartbeat = async () => {
    await telemetry.updateOne(
      { kind: "voice_worker_stats" },
      {
        $set: {
          kind: "voice_worker_stats",
          supervisorIdentity: identity,
          supervisorUpdatedAt: new Date(),
          activeCalls: 0,
          cellDefaults: { defaultStt: "deepgram/flux-general-en", defaultTts: "cartesia/sonic-3" },
          updatedAt: new Date(),
        },
        $setOnInsert: { lastError: null, callsStarted: 0, callsCompleted: 0 },
      },
      { upsert: true },
    );
  };
  await writeHeartbeat();
  setInterval(() => {
    writeHeartbeat().catch(() => {});
  }, 5_000).unref();
  writeBootIdentityRecord(recordPath, identity);
}

process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
